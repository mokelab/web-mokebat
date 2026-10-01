// モケラバトル Web 版（モケラ vs ぴよ）の画面。
// 構築・選出・盤面・棋譜はすべて wasm 側（core の WebGame）にあり、ここは表示と入力だけを持つ。
// 盤面の更新・文言・描画の部品は battle-common.js（棋譜ビューアと共通）。

const $ = id => document.getElementById(id);

/** 陣営。自分が 0（青）、ぴよが 1（赤） */
const HUMAN = 0;
const AI = 1;
const LABELS = ['あなた', 'ぴよ'];

/**
 * ぴよの強さ。ai は AiCatalog の id、team はぴよの構築（SampleData.teams の名前）。
 * 対応は仮で、遊んでから決める（docs/web-app.md §6）
 */
const STAGES = [
  { name: 'あくび', note: '手加減している', ai: 'steady:sleepy', team: 'beta' },
  { name: 'ふつう', note: '普通に相手をする', ai: 'tactician:normal', team: 'beta' },
  { name: 'むきになる', note: '本気を出しかける', ai: 'aggressive:hard', team: 'alpha' },
  { name: '本気', note: '帽子から降りる', ai: 'fable', team: 'beta' },
];

const PRESET_NOTES = { alpha: '近接寄り', beta: '遠隔寄り', gamma: '主砲寄り' };

/** 構築の保存先。形は { name, members: [{ characterId, weaponId, skillIds? }] } */
const TEAM_KEY = 'mokebat.team';

/** ぴよが考えている間（演出） */
const THINK_MS = 500;

let core;
let catalog;
let presets;
const characters = new Map();
const weapons = new Map();

let stage = STAGES[0];
let team = { name: 'player', members: [] };
/** 選出の前に分かること（自分の構築、ぴよの構築の公開情報、前の試合で見た技） */
let preview = null;
let picks = [];
let leads = ['FRONT', 'BACK'];
let seed = '';

/** 表示用の対戦の情報。units[side][unit] がそのユニットのメンバー（ぴよの側は場に出て分かったものだけ） */
let g = null;
let board = null;
let highlight = [];
/** wasm から返ってきた最新の状態 */
let dto = null;
/** 枠ごとに選んだ行動 */
let chosen = [null, null];
/** 選んでいる補充 */
let replacing = [];
let skipping = false;
let wake = null;

/** wasm の関数を呼ぶ。引数と戻り値は JSON（数値はそのまま渡す） */
function call(name, ...args) {
  const r = JSON.parse(core[name](...args.map(a => (typeof a === 'number' ? a : JSON.stringify(a)))));
  if (r && r.error) throw new Error(r.error);
  return r;
}

function show(id) {
  document.querySelectorAll('.screen').forEach(el => { el.hidden = el.id !== id; });
  window.scrollTo(0, 0);
}

// ---------- 共通の表示 ----------

function statsText(c) {
  const s = c.stats;
  return `HP${s.hp} 攻${s.attack} 防${s.defense} 速${s.speed} 燃費${s.efficiency}`;
}

function weaponHead(w) {
  return `${w.name}（${w.range === 'MELEE' ? '近接' : '遠隔'}）`;
}

/** @param known 見たことのある技のインデックス（相手の技に印を付ける）。省略すると印なし */
function skillList(w, known) {
  const items = w.skills.map((sk, i) => {
    const seen = known?.includes(i);
    return `<li class="${seen ? 'known' : ''}">${esc(sk.name)}: ${esc(sk.effects.map(effectText).join(' + '))} / 消費${sk.cost}${seen ? '（見た）' : ''}</li>`;
  });
  return `<ul class="skills">${items.join('')}</ul>`;
}

/** 技名だけを並べる。押すと説明のダイアログが開く。known は skillList と同じ */
function skillChips(w, known) {
  const items = w.skills.map((sk, i) => {
    const seen = known?.includes(i);
    return `<button class="chip ${seen ? 'known' : ''}" data-skill="${i}" data-skill-weapon="${w.id}" ${seen ? 'data-seen' : ''}>${seen ? '✓ ' : ''}${esc(sk.name)}</button>`;
  });
  return `<div class="chips">${items.join('')}</div>`;
}

function openSkill(b) {
  const sk = weapons.get(b.dataset.skillWeapon).skills[Number(b.dataset.skill)];
  $('skillName').textContent = sk.name;
  $('skillBody').innerHTML = sk.effects.map(e => `<li>${esc(effectText(e))}</li>`).join('')
    + `<li>消費${sk.cost}</li>`
    + ('seen' in b.dataset ? '<li class="muted">前の試合で見た技</li>' : '');
  $('skillDialog').showModal();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-skill]');
  if (b) openSkill(b);
});

// 外側（backdrop）を押しても閉じる
$('skillDialog').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.close();
});

function member(spec) {
  return { character: characters.get(spec.characterId), weapon: weapons.get(spec.weaponId) };
}

// ---------- 強さ ----------

function renderStages() {
  $('stages').innerHTML = STAGES.map((s, i) =>
    `<button class="card pick" data-stage="${i}"><div class="name">${esc(s.name)}</div><div class="muted small">${esc(s.note)}</div></button>`).join('');
}

$('stages').addEventListener('click', e => {
  const b = e.target.closest('[data-stage]');
  if (!b) return;
  stage = STAGES[Number(b.dataset.stage)];
  renderBuild();
  show('build');
});

// ---------- 構築 ----------

function loadTeam() {
  try {
    const saved = JSON.parse(localStorage.getItem(TEAM_KEY));
    const ok = saved?.members?.every(m => characters.has(m.characterId) && weapons.has(m.weaponId));
    if (ok) return { name: 'player', members: saved.members.map(m => ({ characterId: m.characterId, weaponId: m.weaponId })) };
  } catch {
    // 読めなければ、おすすめの構築から始める
  }
  return { name: 'player', members: presets[0].members.map(m => ({ ...m })) };
}

function saveTeam() {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(team));
  } catch {
    // 保存できなくても遊べる
  }
}

function renderBuild() {
  const size = catalog.config.teamSize;
  $('teamCount').textContent = `${team.members.length}/${size} ・ 相手: ぴよ（${stage.name}）`;
  $('team').innerHTML = team.members.map((spec, i) => {
    const m = member(spec);
    const options = catalog.weapons.filter(w => m.character.weaponIds.includes(w.id))
      .map(w => `<option value="${w.id}" ${w.id === spec.weaponId ? 'selected' : ''}>${esc(weaponHead(w))}</option>`).join('');
    return `<div class="card mine">
      <div class="row"><span class="name">${esc(m.character.name)}</span><select data-weapon="${i}">${options}</select><button data-remove="${i}">外す</button></div>
      <div class="muted small">${statsText(m.character)}</div>
      ${skillList(m.weapon)}
    </div>`;
  }).join('') || '<div class="muted">下のコマを押して入れてください</div>';

  const inTeam = new Set(team.members.map(m => m.characterId));
  $('pool').innerHTML = catalog.characters.map(c => {
    const names = catalog.weapons.filter(w => c.weaponIds.includes(w.id)).map(w => w.name).join('・');
    const used = inTeam.has(c.id);
    return `<button class="card pick ${used ? 'chosen' : ''}" data-add="${c.id}" ${used || team.members.length >= size ? 'disabled' : ''}>
      <div class="name">${esc(c.name)}</div>
      <div class="small">${statsText(c)}</div>
      <div class="muted small">${esc(names)}</div>
    </button>`;
  }).join('');

  const errors = call('validateTeam', team).errors;
  $('teamError').textContent = errors.join('\n');
  $('toSelect').disabled = errors.length > 0;
  saveTeam();
}

function renderStatic() {
  $('presets').innerHTML = presets.map((p, i) =>
    `<button data-preset="${i}">${esc(p.name)}${PRESET_NOTES[p.name] ? `（${PRESET_NOTES[p.name]}）` : ''}</button>`).join('');
  $('weapons').innerHTML = catalog.weapons.map(w =>
    `<div class="card"><div class="name">${esc(weaponHead(w))}</div>${skillList(w)}</div>`).join('');
}

$('presets').addEventListener('click', e => {
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  team = { name: 'player', members: presets[Number(b.dataset.preset)].members.map(m => ({ ...m })) };
  renderBuild();
});

$('clearTeam').addEventListener('click', () => {
  team = { name: 'player', members: [] };
  renderBuild();
});

$('team').addEventListener('click', e => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  team.members.splice(Number(b.dataset.remove), 1);
  renderBuild();
});

$('team').addEventListener('change', e => {
  const s = e.target.closest('[data-weapon]');
  if (!s) return;
  team.members[Number(s.dataset.weapon)].weaponId = s.value;
  renderBuild();
});

$('pool').addEventListener('click', e => {
  const b = e.target.closest('[data-add]');
  if (!b || b.disabled) return;
  const c = characters.get(b.dataset.add);
  const weapon = catalog.weapons.find(w => c.weaponIds.includes(w.id));
  team.members.push({ characterId: c.id, weaponId: weapon.id });
  renderBuild();
});

$('toSelect').addEventListener('click', () => {
  // seed は棋譜の meta に残る。64 ビットは JS の数値に入らないので文字列で渡す
  seed = BigInt.asIntN(64, crypto.getRandomValues(new BigUint64Array(1))[0]).toString();
  preview = call('newBattle', { team, ai: stage.ai, seed, opponentTeam: stage.team });
  openSelect();
});

// ---------- 選出 ----------

function openSelect() {
  picks = [];
  leads = ['FRONT', 'BACK'];
  renderSelect();
  show('select');
}

function renderSelect() {
  const count = catalog.config.pickCount;
  $('setGame').textContent = preview.game > 0 ? `同じ構築の ${preview.game + 1} 試合目` : '';
  $('oppTeam').innerHTML = preview.opponent.map((m, i) => `<div class="card theirs">
    <div class="name">${esc(m.character.name)} <span class="muted small">${esc(weaponHead(m.weapon))}</span></div>
    <div class="muted small">${statsText(m.character)}</div>
    ${skillChips(m.weapon, preview.knownSkills[i] ?? [])}
  </div>`).join('');

  $('myTeam').innerHTML = preview.team.members.map((m, i) => {
    const order = picks.indexOf(i);
    const badge = order < 0 ? '' : `<span class="badge pos p0">${order + 1} ${order < 2 ? '先発' : '控え'}</span>`;
    // 中に技のボタンを置くので、カードは button にしない
    const off = order < 0 && picks.length >= count;
    return `<div class="card pick ${order >= 0 ? 'chosen' : ''} ${off ? 'off' : ''}" role="button" tabindex="${off ? -1 : 0}" aria-disabled="${off}" data-pick="${i}">
      <div class="name">${esc(m.character.name)} <span class="muted small">${esc(weaponHead(m.weapon))}</span>${badge}</div>
      <div class="muted small">${statsText(m.character)}</div>
      ${skillChips(m.weapon)}
    </div>`;
  }).join('');

  const rows = [0, 1].map(i => {
    const who = picks[i] == null ? '<span class="muted">（未選択）</span>' : esc(memberName(preview.team.members[picks[i]]));
    const buttons = ['FRONT', 'BACK'].map(p =>
      `<button data-lead="${i}" data-position="${p}" class="${leads[i] === p ? 'on' : ''}">${POSITION[p]}衛</button>`).join('');
    return `<div class="row" style="margin-bottom:4px"><span>先発 ${i + 1}: ${who}</span>${buttons}</div>`;
  });
  const note = leads.every(p => p === 'BACK') ? '<div class="muted small">2 体とも後衛にはできないので、2 体とも前衛として出ます</div>' : '';
  $('picks').innerHTML = rows.join('') + note;
  $('toBattle').disabled = picks.length !== count;
}

function togglePick(b) {
  if (!b || b.classList.contains('off')) return;
  const i = Number(b.dataset.pick);
  picks = picks.includes(i) ? picks.filter(p => p !== i) : [...picks, i];
  renderSelect();
}

$('myTeam').addEventListener('click', e => {
  // 技を押したときは説明を開くだけで、選出は変えない
  if (e.target.closest('[data-skill]')) return;
  togglePick(e.target.closest('[data-pick]'));
});

$('myTeam').addEventListener('keydown', e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches('[data-pick]')) return;
  e.preventDefault();
  const i = e.target.dataset.pick;
  togglePick(e.target);
  $('myTeam').querySelector(`[data-pick="${i}"]`)?.focus();
});

$('picks').addEventListener('click', e => {
  const b = e.target.closest('[data-lead]');
  if (!b) return;
  leads[Number(b.dataset.lead)] = b.dataset.position;
  renderSelect();
});

$('selectBack').addEventListener('click', () => { renderBuild(); show('build'); });

$('toBattle').addEventListener('click', () => {
  const first = call('select', { picks, leadPositions: leads });
  g = { labels: LABELS, units: [picks.map(i => preview.team.members[i]), []] };
  board = boardOf(first.view);
  highlight = [];
  $('log').innerHTML = '';
  $('result').hidden = true;
  $('battleError').textContent = '';
  show('battle');
  advance(first);
});

// ---------- 対戦 ----------

/** wasm から来た盤面を、battle-common.js の盤面の形にする。ぴよのユニットが誰かも覚える */
function boardOf(view) {
  view.opponent.units.forEach((u, i) => { if (u) g.units[AI][i] = preview.opponent[u.teamIndex]; });
  return {
    turn: view.turn,
    wind: view.wind,
    lobs: view.lobs.map(l => ({ ...l, fresh: false })),
    sides: [
      { units: view.me.units.map(u => ({ ...u })), slots: view.me.slots.map(sl => sl && { ...sl }) },
      { units: view.opponent.units.map(u => u && { ...u }), slots: view.opponent.slots.map(sl => sl && { ...sl }) },
    ],
  };
}

/** ぴよの控えが初めて場に出るイベントなら、盤面にそのユニットを足す（場に出たことがないので HP もチャージも満タン） */
function reveal(b, e) {
  const unit = e.type === 'Switched' ? e.inUnit : e.type === 'Replaced' ? e.unit : null;
  if (unit == null || e.side !== AI || b.sides[AI].units[unit]) return b;
  const c = clone(b);
  c.sides[AI].units[unit] = {
    hpPercent: 100,
    charge: g.units[AI][unit].weapon.maxCharge,
    knownSkills: [],
    guardedLastTurn: false,
    paralyzed: false,
    usedFlinchLastTurn: false,
    windup: null,
    pinned: false,
    slowed: false,
    decoyedLastTurn: false,
  };
  return c;
}

function wait(ms) {
  if (skipping) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

$('skip').addEventListener('click', () => {
  skipping = true;
  wake?.();
});

$('next').addEventListener('click', () => wake?.());

/** 「次へ」を押すまで待つ（表示の速さが「手動」のとき） */
function waitForNext() {
  if (skipping) return Promise.resolve();
  $('next').hidden = false;
  return new Promise(resolve => {
    wake = () => {
      wake = null;
      $('next').hidden = true;
      resolve();
    };
  });
}

/** 行動の始まり（誰が何をするか）のイベント。結果のイベントより長く見せる */
const LEAD_EVENTS = new Set(['SkillUsed', 'BasicAttacked', 'Released', 'LobLanded', 'Switched', 'Replaced', 'Guarded', 'Moved', 'BattleEnded']);

/** そのイベントを見せておく長さ。表示の速さが「手動」なら「次へ」を待つ */
function pause(e) {
  const speed = Number($('speed').value);
  if (speed === 0) return e.type === 'TurnStarted' ? wait(400) : waitForNext();
  return wait(e.type === 'TurnStarted' ? speed * 0.6 : LEAD_EVENTS.has(e.type) ? speed * 1.3 : speed);
}

/** 盤面に重ねて出す演出（ダメージの数字など）。{ side, unit, text, cls } */
let popups = [];
/** 直前の盤面。HP とチャージのバーを、前の値から動かすのに使う */
let prevBoard = null;

/** ダメージの数字。相手の分は割合しか分からない */
function damagePopup(before, e) {
  if (e.type !== 'Damaged') return [];
  const u = before.sides[e.side].units[e.unit];
  const text = e.hpPercentAfter != null ? `-${Math.max(0, u.hpPercent - e.hpPercentAfter)}%` : `-${e.amount}`;
  return [{ side: e.side, unit: e.unit, text, cls: 'dmg' }];
}

const POPUP_TEXT = { Blocked: '防いだ', Missed: 'ミス', Paralyzed: '麻痺', Flinched: 'ひるみ', Pinned: '影縫い', Slowed: '鈍足', ActionFailed: '失敗', Faltered: '動けない' };

function popupsOf(before, e) {
  if (e.type === 'Damaged') return damagePopup(before, e);
  if (e.type === 'Recharged') return [{ side: e.side, unit: e.toUnit, text: `+${Math.round(e.amount)}`, cls: 'heal' }];
  return POPUP_TEXT[e.type] ? [{ side: e.side, unit: e.unit, text: POPUP_TEXT[e.type], cls: 'note' }] : [];
}

/** イベントを 1 つずつ盤面に反映しながら見せる */
async function playEvents(events, after) {
  // このターンに初めて出てきたぴよのユニットの名前を、先に引けるようにしておく
  after.opponent.units.forEach((u, i) => { if (u) g.units[AI][i] = preview.opponent[u.teamIndex]; });
  skipping = false;
  $('skip').hidden = events.length === 0;
  for (const e of events) {
    board = reveal(board, e);
    const text = eventText(g, board, e);
    // ダメージなどを受けた瞬間だけ揺らす。行動の対象は枠で示す
    const impact = e.type === 'Damaged' || e.type === 'Fainted';
    highlight = highlightOf(board, e).map(h => (h.kind === 'hit' && !impact ? { ...h, kind: 'target' } : h));
    popups = popupsOf(board, e);
    prevBoard = board;
    // 倒れたユニットは、消える前の盤面で倒れる様子を見せる
    if (e.type === 'Fainted') highlight = [{ side: e.side, unit: e.unit, kind: 'faint' }];
    else board = apply(board, e);
    appendLog(e, text);
    setStatus(text, e.side);
    renderBoard();
    await pause(e);
    if (e.type === 'Fainted') board = apply(board, e);
  }
  $('skip').hidden = true;
  $('next').hidden = true;
  // 最後は wasm の盤面に合わせる（防御の持ち越しやターン終わりの陣形の読み替えを反映）
  board = boardOf(after);
  highlight = [];
  popups = [];
  prevBoard = null;
  renderBoard();
}

/** いま起きていることを大きく出す。side があれば陣営の色にする */
function setStatus(text, side) {
  $('status').textContent = text;
  $('status').className = side == null ? '' : `p${side}`;
}

function appendLog(e, text) {
  const li = document.createElement('li');
  li.textContent = text;
  if (e.type === 'TurnStarted' || e.type === 'BattleEnded') li.className = 'turn';
  else if (SUB_EVENTS.has(e.type)) li.className = 'sub';
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

/** wasm から返ってきた状態を見せて、次の入力（行動・補充）か結果に進む */
async function advance(d) {
  dto = d;
  $('input').hidden = true;
  await playEvents(d.events, d.view);
  if (d.outcome) showResult();
  else if (d.pending.length) askReplacements();
  else askActions();
}

/** wasm を呼んで先に進める。失敗したら文言を出して、入力に戻す */
async function submit(name, arg) {
  $('battleError').textContent = '';
  try {
    await advance(call(name, arg));
  } catch (err) {
    $('battleError').textContent = `エラー: ${err.message}`;
    $('input').hidden = false;
    console.error(err);
  }
}

function renderBoard() {
  const kind = (side, unit) => highlight.find(h => h.side === side && h.unit === unit)?.kind ?? '';
  $('turnInfo').textContent = `ターン ${board.turn + 1}${board.wind > 0 ? ` / 風 残り${board.wind}` : ''} / ぴよ（${stage.name}）`;
  $('board').innerHTML = [HUMAN, AI].map(si => {
    const side = board.sides[si];
    const mine = si === HUMAN;
    const hpBar = (m, u) => mine
      ? bar('HP', u.hp, m.character.stats.hp, hpColor(u.hp / m.character.stats.hp))
      : bar('HP', u.hpPercent, 100, hpColor(u.hpPercent / 100), `${u.hpPercent}%`);
    // 直前の盤面での HP とチャージの割合（バーをそこから動かす）
    const from = (m, unit) => {
      const p = prevBoard?.sides[si].units[unit];
      if (!p) return '';
      const hp = mine ? p.hp / m.character.stats.hp : p.hpPercent / 100;
      return `--hp-from:${hp * 100}%;--charge-from:${(p.charge / m.weapon.maxCharge) * 100}%`;
    };
    const popup = unit => popups.filter(p => p.side === si && p.unit === unit)
      .map(p => `<span class="popup ${p.cls}">${esc(p.text)}</span>`).join('');
    const slots = side.slots.map((sl, slot) => {
      if (!sl) return `<div class="card empty">枠${slot} (空)</div>`;
      const m = g.units[si][sl.unit];
      const u = side.units[sl.unit];
      return `<div class="card ${mine ? 'mine' : 'theirs'} ${sl.position === 'BACK' ? 'back' : ''} ${kind(si, sl.unit)}" style="${from(m, sl.unit)}">
        ${popup(sl.unit)}
        <div class="name">${esc(memberName(m))}<span class="badge pos p${si}">${POSITION[sl.position]}</span>${statusBadges(u)}</div>
        <div class="hp">${hpBar(m, u)}</div>
        <div class="charge">${bar('チャージ', u.charge, m.weapon.maxCharge, 'var(--charge)')}</div>
        <details><summary>${statsText(m.character)}</summary>${skillList(m.weapon, mine ? undefined : u.knownSkills)}</details>
      </div>`;
    }).join('');
    const onField = new Set(side.slots.filter(Boolean).map(sl => sl.unit));
    const bench = side.units.map((u, i) => {
      if (onField.has(i)) return '';
      // ぴよの控えは、場に出るまで誰か分からない
      if (!u) return '<span>？</span>';
      const hp = mine ? u.hp : u.hpPercent;
      const cls = [hp <= 0 ? 'fainted' : '', kind(si, i)].join(' ');
      return `<span class="${cls}">${esc(memberName(g.units[si][i]))} HP${mine ? u.hp : `${u.hpPercent}%`}${u.paralyzed ? ' 麻痺' : ''}</span>`;
    }).join('');
    const lobs = board.lobs.filter(l => l.target.side === si)
      .map(l => `<span class="badge">曲射${l.fresh ? '(次ターン)' : ''}↓${POSITION[l.position]}衛</span>`).join('');
    return `<div class="side s${si}">
      <h2 class="p${si}">${LABELS[si]}<span class="formation muted">${FORMATION[formation(side)]}</span>${lobs}</h2>
      <div class="slots">${slots}</div>
      <div class="bench"><span class="muted plain">控え:</span>${bench || '<span class="muted plain">なし</span>'}</div>
    </div>`;
  }).join('');
}

// ---------- 行動の入力 ----------

function targetName(t) {
  const sl = board.sides[t.side].slots[t.slot];
  return `${LABELS[t.side]}の${memberName(g.units[t.side][sl.unit])}（${POSITION[sl.position]}衛）`;
}

/**
 * 枠の合法手を「何をするか」でまとめる。技は武器の技を全部並べ、いま使えないものは options が空になる。
 * options は { action, label, sub }（誰に・誰と）。1 つしかなければ選ぶまでもなく決まる
 */
function commandsOf(slot) {
  const me = board.sides[HUMAN];
  const sl = me.slots[slot];
  const u = me.units[sl.unit];
  const m = g.units[HUMAN][sl.unit];
  const legal = dto.legal[slot];
  const toTarget = a => ({ action: a, label: targetName(a.target), sub: '' });
  const commands = m.weapon.skills.map((sk, i) => {
    // 実際に払うチャージは、技の消費量を燃費で割った値
    const cost = Math.round(sk.cost / m.character.stats.efficiency);
    return {
      key: `skill${i}`,
      main: u.windup?.skillIndex === i ? `${sk.name}（解放）` : sk.name,
      sub: u.windup?.skillIndex === i ? '溜めた技を放つ' : `${sk.effects.map(effectText).join(' + ')} / 消費${cost}`,
      // 自分に使う技は対象を選ばない
      ask: sk.target.type === 'Self' ? null : sk.target.type === 'Partner' ? '誰に（相方）' : '誰に',
      options: legal.filter(a => a.type === 'UseSkill' && a.skillIndex === i).map(toTarget),
    };
  });
  commands.push({
    key: 'basic',
    main: '基本攻撃',
    sub: `威力${catalog.config.basicAttackPower} / 消費なし`,
    ask: '誰に',
    options: legal.filter(a => a.type === 'BasicAttack').map(toTarget),
  });
  commands.push({
    key: 'switch',
    main: '交代',
    sub: '控えと入れ替わる',
    ask: '誰と',
    options: legal.filter(a => a.type === 'Switch')
      .map(a => ({ action: a, label: memberName(g.units[HUMAN][a.benchUnit]), sub: `HP${me.units[a.benchUnit].hp}` })),
  });
  commands.push({
    key: 'move',
    main: '位置変更',
    sub: sl.position === 'FRONT' ? '後衛へ下がる' : '前衛へ出る',
    ask: null,
    options: legal.filter(a => a.type === 'Move').map(a => ({ action: a, label: '', sub: '' })),
  });
  // 防御と待機は、選べるときだけ出す
  const extra = [['Guard', '防御', 'このターンのダメージを受けない'], ['Pass', '待機', '何もしない']];
  extra.forEach(([type, main, sub]) => {
    const options = legal.filter(a => a.type === type).map(a => ({ action: a, label: '', sub: '' }));
    if (options.length) commands.push({ key: type, main, sub, ask: null, options });
  });
  return commands;
}

/** 枠ごとに選んだ「何をするか」（commandsOf の key） */
let command = [null, null];

function selectCommand(slot, key) {
  const c = commandsOf(slot).find(x => x.key === key);
  command[slot] = key;
  // 相手が 1 つしかなければ、そこで決まる
  chosen[slot] = c.options.length === 1 ? c.options[0].action : null;
}

function askActions() {
  command = [null, null];
  chosen = [null, null];
  dto.legal.forEach((list, slot) => {
    if (!list.length) return;
    // 選べるものが 1 つだけなら（溜めた技の解放など）、選んだことにする
    const usable = commandsOf(slot).filter(c => c.options.length);
    if (usable.length === 1) selectCommand(slot, usable[0].key);
  });
  setStatus('行動を選んでください');
  renderActions();
  $('input').hidden = false;
}

function renderActions() {
  const me = board.sides[HUMAN];
  const blocks = dto.legal.map((list, slot) => {
    const sl = me.slots[slot];
    if (!sl) return '';
    const commands = commandsOf(slot);
    const buttons = commands.map(c =>
      `<button data-slot="${slot}" data-command="${c.key}" class="${command[slot] === c.key ? 'on' : ''}" ${c.options.length ? '' : 'disabled'}>${esc(c.main)}<span class="sub">${esc(c.sub)}</span></button>`).join('');
    const current = commands.find(c => c.key === command[slot]);
    let second = '';
    if (current?.ask) {
      const targets = current.options.map((o, i) =>
        `<button data-slot="${slot}" data-option="${i}" class="${chosen[slot] === o.action ? 'on' : ''}">${esc(o.label)}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</button>`).join('');
      second = `<div class="options second"><span class="ask">${esc(current.ask)}</span>${targets}</div>`;
    }
    return `<div class="slot-input">
      <div><b class="p0">${esc(memberName(g.units[HUMAN][sl.unit]))}</b><span class="badge pos p0">${POSITION[sl.position]}</span>${chosen[slot] ? '<span class="badge done">決まり</span>' : ''}</div>
      <div class="options">${buttons}</div>
      ${second}
    </div>`;
  });
  const ready = dto.legal.every((list, slot) => list.length === 0 || chosen[slot]);
  $('input').innerHTML = `${blocks.join('')}<button id="confirm" class="primary" ${ready ? '' : 'disabled'}>決定</button>`;
}

function benchUnits() {
  const me = board.sides[HUMAN];
  return me.units.map((u, i) => i).filter(i => me.units[i].hp > 0 && !me.slots.some(sl => sl?.unit === i));
}

function askReplacements() {
  const bench = benchUnits();
  // 控えの数と空き枠の数が同じなら、出すユニットは決まっている
  replacing = dto.pending.map((slot, i) => ({ slot, unit: bench.length === dto.pending.length ? bench[i] : null, position: 'FRONT' }));
  setStatus('倒れた枠に出すコマを選んでください');
  renderReplacements();
  $('input').hidden = false;
}

function renderReplacements() {
  const me = board.sides[HUMAN];
  const blocks = replacing.map((r, i) => {
    const units = benchUnits().map(u => {
      const taken = replacing.some((o, j) => j !== i && o.unit === u);
      return `<button data-rep="${i}" data-unit="${u}" class="${r.unit === u ? 'on' : ''}" ${taken ? 'disabled' : ''}>${esc(memberName(g.units[HUMAN][u]))}<span class="sub">HP${me.units[u].hp}</span></button>`;
    }).join('');
    const positions = ['FRONT', 'BACK'].map(p =>
      `<button data-rep="${i}" data-position="${p}" class="${r.position === p ? 'on' : ''}">${POSITION[p]}衛</button>`).join('');
    return `<div class="slot-input">
      <div><b class="p0">枠${r.slot}</b> に出す</div>
      <div class="options">${units}</div>
      <div class="options">${positions}</div>
    </div>`;
  });
  const ready = replacing.every(r => r.unit != null);
  $('input').innerHTML = `${blocks.join('')}
    <div class="muted small">場に残っている後衛は前衛に上がります（後衛で出すと、前後が入れ替わる形になります）</div>
    <button id="confirm" class="primary" ${ready ? '' : 'disabled'}>出す</button>`;
}

$('input').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.id === 'confirm') {
    $('input').hidden = true;
    if (dto.pending.length) {
      await submit('submitReplacements', replacing);
    } else {
      setStatus('ぴよが考えている…', AI);
      await new Promise(resolve => setTimeout(resolve, THINK_MS));
      await submit('submitTurn', chosen);
    }
  } else if (b.dataset.command != null) {
    selectCommand(Number(b.dataset.slot), b.dataset.command);
    renderActions();
  } else if (b.dataset.option != null) {
    const slot = Number(b.dataset.slot);
    chosen[slot] = commandsOf(slot).find(c => c.key === command[slot]).options[Number(b.dataset.option)].action;
    renderActions();
  } else if (b.dataset.unit != null) {
    replacing[Number(b.dataset.rep)].unit = Number(b.dataset.unit);
    renderReplacements();
  } else if (b.dataset.position != null) {
    replacing[Number(b.dataset.rep)].position = b.dataset.position;
    renderReplacements();
  }
});

// ---------- 結果 ----------

function showResult() {
  const o = dto.outcome;
  const text = o.type === 'Draw' ? '引き分け' : o.side === HUMAN ? 'あなたの勝ち！' : 'ぴよの勝ち';
  $('resultText').textContent = `${text}（${board.turn} ターン）`;
  $('resultText').className = o.type === 'Draw' ? '' : `p${o.side}`;
  setStatus('');
  $('result').hidden = false;
}

$('again').addEventListener('click', () => {
  preview = call('nextGame');
  openSelect();
});

$('rebuild').addEventListener('click', () => { renderBuild(); show('build'); });

$('download').addEventListener('click', () => {
  const blob = new Blob([call('kifu').kifu + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mokebat-${seed}-${preview.game}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- 起動 ----------

const SPEED_KEY = 'mokebat.speed';
try {
  const saved = localStorage.getItem(SPEED_KEY);
  if ([...$('speed').options].some(o => o.value === saved)) $('speed').value = saved;
} catch {
  // 読めなければ既定の速さ
}
$('speed').addEventListener('change', () => {
  try {
    localStorage.setItem(SPEED_KEY, $('speed').value);
  } catch {
    // 保存できなくても遊べる
  }
  // 手動から切り替えたら、止まっているところから進める
  if ($('speed').value !== '0' && !$('next').hidden) wake?.();
});

$('start').addEventListener('click', () => show('stage'));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));

async function main() {
  try {
    core = await import('./core/pvp-core.mjs');
  } catch (err) {
    // Kotlin/Wasm は Wasm GC が要る。file:// で開いたときもモジュールを読めない
    $('loading').innerHTML = `このブラウザでは動きませんでした。Chrome 119 以降・Firefox 120 以降・Safari 18.2 以降で、http(s) で配信したページを開いてください。<div class="muted small">${esc(err.message ?? err)}</div>`;
    console.error(err);
    return;
  }
  catalog = call('catalog');
  presets = call('presetTeams');
  catalog.characters.forEach(c => characters.set(c.id, c));
  catalog.weapons.forEach(w => weapons.set(w.id, w));
  team = loadTeam();
  renderStatic();
  renderStages();
  $('loading').hidden = true;
  show('title');
}

main();

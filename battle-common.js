'use strict';

// 棋譜ビューア（viewer/index.html）と Web 版（web/index.html）で共通の、盤面の更新・文言・描画の部品。
// 盤面は { turn, wind, lobs, sides: [{ units, slots }] } の形で、g.units[side][unit] がそのユニットのメンバー（キャラ + 武器）。

function clone(board) {
  return {
    turn: board.turn,
    wind: board.wind,
    lobs: board.lobs.map(l => ({ ...l })),
    sides: board.sides.map(s => ({
      // Web 版では、まだ場に出ていない相手のユニットは null
      units: s.units.map(u => u && { ...u }),
      slots: s.slots.map(sl => sl && { ...sl }),
    })),
  };
}

/** イベントを盤面に適用する（BattleEngine.kt の更新に対応） */
function apply(board, e) {
  const b = clone(board);
  const side = b.sides[e.side];
  switch (e.type) {
    case 'SkillUsed':
    case 'Guarded':
      side.units[e.unit].charge = Math.max(0, side.units[e.unit].charge - e.cost);
      break;
    case 'Faltered':
      side.units[e.unit].charge = Math.max(0, side.units[e.unit].charge - e.cost);
      // 解放の前にひるむと溜めを失う
      side.units[e.unit].windup = null;
      break;
    case 'WoundUp':
      side.units[e.unit].windup = { skillIndex: -1, target: e.target };
      break;
    case 'Released':
    case 'ActionFailed':
      // 解放した・届かず失敗した（溜めていないユニットの失敗なら何も変わらない）
      side.units[e.unit].windup = null;
      // 空振りでも技のチャージは払う
      side.units[e.unit].charge = Math.max(0, side.units[e.unit].charge - (e.cost ?? 0));
      break;
    case 'Lobbed':
      b.lobs.push({ side: e.side, unit: e.unit, target: e.target, position: e.position, fresh: true });
      break;
    case 'LobLanded':
    case 'LobMissed': {
      const i = b.lobs.findIndex(l => !l.fresh && l.side === e.side && l.unit === e.unit);
      if (i >= 0) b.lobs.splice(i, 1);
      break;
    }
    case 'Recharged':
      side.units[e.toUnit].charge += e.amount;
      break;
    case 'Damaged':
      // Web 版では、相手が受けたダメージは残り HP の割合だけが来る
      if (e.hpPercentAfter != null) side.units[e.unit].hpPercent = e.hpPercentAfter;
      else side.units[e.unit].hp = e.hpAfter;
      break;
    case 'Fainted': {
      const i = side.slots.findIndex(sl => sl && sl.unit === e.unit);
      if (i >= 0) side.slots[i] = null;
      break;
    }
    case 'Paralyzed':
      side.units[e.unit].paralyzed = true;
      break;
    case 'WindBlew':
      b.wind = e.turns;
      break;
    case 'WindCalmed':
      b.wind = 0;
      break;
    case 'Pulled': {
      const sl = side.slots.find(sl => sl && sl.unit === e.unit);
      if (sl) sl.position = 'FRONT';
      break;
    }
    case 'Swapped':
      side.slots.forEach(sl => { if (sl) sl.position = sl.position === 'FRONT' ? 'BACK' : 'FRONT'; });
      break;
    case 'Switched':
      side.slots[e.slot].unit = e.inUnit;
      break;
    case 'Moved': {
      const sl = side.slots.find(sl => sl && sl.unit === e.unit);
      if (sl) sl.position = sl.position === 'FRONT' ? 'BACK' : 'FRONT';
      normalize(side);
      break;
    }
    case 'Replaced':
      // 補充のとき、場に残っている後衛は前衛に上がる（同じターンに補充したユニットは除く）
      side.slots.forEach(sl => { if (sl && !sl.fresh) sl.position = 'FRONT'; });
      side.slots[e.slot] = { unit: e.unit, position: e.position, fresh: true };
      normalize(side);
      break;
  }
  return b;
}

/** 場に前衛がいなければ全員前衛にする（Rules.kt の normalize） */
function normalize(side) {
  const active = side.slots.filter(Boolean);
  if (active.length && !active.some(sl => sl.position === 'FRONT')) active.forEach(sl => { sl.position = 'FRONT'; });
}

function unitAtTarget(board, t) {
  return board.sides[t.side].slots[t.slot]?.unit;
}

/** そのイベントで行動したユニット（actor）と受けたユニット（hit） */
function highlightOf(board, e) {
  const h = [];
  const add = (side, unit, kind) => { if (unit != null) h.push({ side, unit, kind }); };
  switch (e.type) {
    case 'SkillUsed':
    case 'BasicAttacked':
    case 'Released':
    case 'LobLanded':
      add(e.side, e.unit, 'actor');
      add(e.target.side, unitAtTarget(board, e.target), 'hit');
      break;
    case 'Recharged':
      add(e.side, e.fromUnit, 'actor');
      add(e.side, e.toUnit, 'hit');
      break;
    case 'Swapped':
      add(e.side, e.unit, 'actor');
      add(e.side, e.partnerUnit, 'hit');
      break;
    case 'Switched':
      add(e.side, e.outUnit, 'actor');
      add(e.side, e.inUnit, 'actor');
      break;
    case 'Damaged':
    case 'Fainted':
    case 'Paralyzed':
    case 'Pinned':
    case 'Slowed':
    case 'Pulled':
    case 'Flinched':
    case 'Blocked':
      add(e.side, e.unit, 'hit');
      break;
    case 'Missed':
    case 'Moved':
    case 'Guarded':
    case 'Decoyed':
    case 'Lured':
    case 'ActionFailed':
    case 'Faltered':
    case 'WoundUp':
    case 'Lobbed':
    case 'LobMissed':
    case 'ChargeDepleted':
    case 'Replaced':
      add(e.side, e.unit, 'actor');
      break;
  }
  return h;
}

// ---------- 文言（sim の LogFormatter.kt に合わせる） ----------

const POSITION = { FRONT: '前', BACK: '後' };
const FORMATION = { FRONT_FRONT: '前+前', FRONT_BACK: '前+後', SINGLE: '単', NONE: '-' };
const ACTION = { UseSkill: '技', BasicAttack: '基本攻撃', Switch: '交代', Move: '位置変更', Guard: '防御', Pass: '待機' };

function memberName(m) {
  return `${m.character.name}(${m.weapon.name})`;
}

/** 陣営の呼び名。g.labels があればそれを使う（Web 版の「あなた」「ぴよ」） */
function sideName(g, side) {
  return g.labels?.[side] ?? `P${side}`;
}

function name(g, side, unit) {
  const m = g.units[side][unit];
  return `${sideName(g, side)} ${m ? memberName(m) : '？'}`;
}

function target(g, board, t) {
  const unit = unitAtTarget(board, t);
  return unit == null ? `${sideName(g, t.side)}枠${t.slot}` : name(g, t.side, unit);
}

function outcomeText(o, g) {
  if (!o) return '決着なし';
  return o.type === 'Win' ? `${g ? sideName(g, o.side) : `P${o.side}`} の勝ち` : '引き分け';
}

function resultText(k) {
  return `結果: ${outcomeText(k.outcome)} (${k.final.turn}ターン)`;
}

function eventText(g, board, e) {
  const n = (side, unit) => name(g, side, unit);
  switch (e.type) {
    case 'TurnStarted': return `--- Turn ${e.turn} ---`;
    case 'SkillUsed': {
      const skill = g.units[e.side][e.unit].weapon.skills[e.skillIndex];
      return `${n(e.side, e.unit)} の ${skill?.name ?? `技${e.skillIndex}`} → ${target(g, board, e.target)} (消費${Math.round(e.cost)})`;
    }
    case 'Released': {
      const skill = g.units[e.side][e.unit].weapon.skills[e.skillIndex];
      return `${n(e.side, e.unit)} の ${skill?.name ?? `技${e.skillIndex}`}（解放） → ${target(g, board, e.target)}`;
    }
    case 'WoundUp': return `${n(e.side, e.unit)} は力を溜めている → ${target(g, board, e.target)}`;
    case 'Lobbed': return `${n(e.side, e.unit)} の曲射は次のターンの最後に ${sideName(g, e.target.side)} の${POSITION[e.position]}衛に落ちる`;
    case 'LobLanded': {
      const skill = g.units[e.side][e.unit].weapon.skills[e.skillIndex];
      return `${n(e.side, e.unit)} の ${skill?.name ?? `技${e.skillIndex}`}（着弾） → ${target(g, board, e.target)}`;
    }
    case 'LobMissed': return `${n(e.side, e.unit)} の曲射は外れた (${e.reason})`;
    case 'BasicAttacked': return `${n(e.side, e.unit)} の基本攻撃 → ${target(g, board, e.target)}`;
    case 'Missed': return '外れた';
    case 'Damaged':
      if (e.hpPercentAfter != null) return `${n(e.side, e.unit)} にダメージ (残りHP ${e.hpPercentAfter}%)`;
      return `${n(e.side, e.unit)} に ${e.amount} ダメージ (残りHP ${e.hpAfter})`;
    case 'Fainted': return `${n(e.side, e.unit)} は倒れた`;
    case 'Recharged': return `${n(e.side, e.fromUnit)} が ${n(e.side, e.toUnit)} のチャージを ${Math.round(e.amount)} 補充`;
    case 'Switched': return `${n(e.side, e.outUnit)} と ${n(e.side, e.inUnit)} が交代`;
    case 'Moved': return `${n(e.side, e.unit)} が位置変更 ${FORMATION[e.before]} → ${FORMATION[e.after]}`;
    case 'Guarded': return `${n(e.side, e.unit)} は防御の構え (消費${Math.round(e.cost)})`;
    case 'Blocked': return `${n(e.side, e.unit)} は攻撃を防いだ`;
    case 'Paralyzed': return `${n(e.side, e.unit)} は麻痺した`;
    case 'Pulled': return `${n(e.side, e.unit)} は前衛に引きずり出された`;
    case 'Pinned': return `${n(e.side, e.unit)} は影を縫われた（次のターン位置が変わらない）`;
    case 'Slowed': return `${n(e.side, e.unit)} は動きが鈍った（次のターン後から動く）`;
    case 'Decoyed': return `${n(e.side, e.unit)} は囮になった（このターン相手の攻撃を引きつける）`;
    case 'Lured': return `${n(e.side, e.unit)} の攻撃は囮に引きつけられた → ${target(g, board, e.target)}`;
    case 'Swapped': return `${n(e.side, e.unit)} と ${n(e.side, e.partnerUnit)} の前後が入れ替わった`;
    case 'Flinched': return `${n(e.side, e.unit)} はひるんだ`;
    case 'Faltered': return `${n(e.side, e.unit)} はひるんで動けない${e.cost > 0 ? ` (チャージ-${Math.round(e.cost)})` : ''}`;
    case 'WindBlew': return `${n(e.side, e.unit)} が風を起こした (${e.turns}ターン)`;
    case 'WindCalmed': return '風がやんだ';
    case 'ActionFailed': return `${n(e.side, e.unit)} の ${ACTION[e.action.type] ?? e.action.type} は失敗 (${e.reason})${e.cost > 0 ? ` (チャージ-${Math.round(e.cost)})` : ''}`;
    case 'ChargeDepleted': return `${n(e.side, e.unit)} はチャージ切れ`;
    case 'Replaced': return `${n(e.side, e.unit)} を枠${e.slot}の${e.position === 'FRONT' ? '前衛' : '後衛'}に出す`;
    case 'BattleEnded': return g.kifu ? resultText(g.kifu) : `結果: ${outcomeText(e.outcome, g)}`;
    default: return e.type;
  }
}

/** 字下げして表示する（結果として起きた）イベント */
const SUB_EVENTS = new Set(['Missed', 'Damaged', 'Fainted', 'Blocked', 'Paralyzed', 'Pulled', 'Swapped', 'Flinched', 'Pinned', 'Slowed', 'Decoyed', 'Lured', 'WoundUp', 'Lobbed', 'ChargeDepleted']);

function formation(side) {
  const active = side.slots.filter(Boolean);
  if (active.length === 0) return 'NONE';
  if (active.length === 1) return 'SINGLE';
  return active.some(sl => sl.position === 'BACK') ? 'FRONT_BACK' : 'FRONT_FRONT';
}

/** @param text 数値の欄に出す文言。省略すると「値/最大」 */
function bar(label, value, max, color, text) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill" style="width:${ratio * 100}%;background:${color}"></div></div><span class="num">${text ?? `${Math.round(value)}/${Math.round(max)}`}</span></div>`;
}

/** ユニットの状態のバッジ */
function statusBadges(u) {
  return [
    u.paralyzed ? '<span class="badge">麻痺</span>' : '',
    u.guardedLastTurn ? '<span class="badge">前ターン防御</span>' : '',
    u.usedFlinchLastTurn ? '<span class="badge">防御半減</span>' : '',
    u.windup ? `<span class="badge">溜め中→枠${u.windup.target.slot}</span>` : '',
    u.pinned ? '<span class="badge">影縫い</span>' : '',
    u.slowed ? '<span class="badge">鈍足</span>' : '',
    u.decoyedLastTurn ? '<span class="badge">前ターン囮</span>' : '',
  ].join('');
}

function hpColor(ratio) {
  if (ratio > 0.5) return 'var(--hp)';
  if (ratio > 0.2) return 'var(--hp-low)';
  return 'var(--hp-crit)';
}

function effectText(e) {
  switch (e.type) {
    case 'Damage': return `威力${e.power}${e.pierce != null ? `（相手の防御を${e.pierce}までとして計算）` : ''}`;
    case 'Recharge': return `補充${e.amount}`;
    case 'Guard': return '防御';
    case 'Paralyze': return `麻痺${Math.round((e.chance ?? 1) * 100)}%`;
    case 'Pull': return '後衛を前衛へ';
    case 'Wind': return `風${e.turns}ターン（遠隔の攻撃技を止める）`;
    case 'Flinch': return 'ひるませる（次ターン自分の防御半減・連続不可）';
    case 'Windup': return '溜め（次ターンの最後に当たる。溜め中は他の行動不可）';
    case 'Pin': return '影縫い（次ターン相手の位置が変わらない）';
    case 'Lob': return '曲射（後衛のみ。次ターンの最後に相手の後衛に落ちる）';
    case 'Swap': return '転位（前+後のとき相方と前後を入れ替える）';
    case 'Slow': return '鈍足（次ターン相手が後から動く）';
    case 'Decoy': return '囮（このターン相手の単体の攻撃を引きつける）';
    default: return e.type;
  }
}

function tooltip(m) {
  const s = m.character.stats;
  const skills = m.weapon.skills.map(sk => `${sk.name}(${(sk.effects ?? []).map(effectText).join('+')}) 消費${sk.cost}`).join(' / ');
  return `攻${s.attack} 防${s.defense} 速${s.speed} 燃費${s.efficiency}\n${m.weapon.range === 'MELEE' ? '近接' : '遠隔'} ${skills}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

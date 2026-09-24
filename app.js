/* Вечерний английский — Telegram Mini App.
   Без фреймворков и сборки. data.js должен быть подключён раньше. */
(function (global) {
'use strict';

/* =====================================================================
   1. КОНСТАНТЫ И ЧИСТАЯ ЛОГИКА  (не трогает DOM и Telegram)
   ===================================================================== */

var DAY_MS = 86400000;
var BASE_UTC = Date.UTC(2026, 0, 1);   /* dateNum 1 == 2026-01-01, 0 == «никогда» */
var CUTOFF_H = 3;                      /* сутки приложения идут с 03:00 до 03:00 */
var NEW_PER_DAY = 6;
var LEARNED_IVL = 21;                  /* карточка считается выученной */
var MAX_IVL = 36500;                   /* 100 лет — дальше расти незачем */
var TOTAL_DAYS = 168;
var STATE_V = 1;
var EVENING_H = 22;                    /* с этого часа вкладка «Сегодня» — вечерняя */

/* Длительности этапов разговора, минуты. Talk не фиксирован: он растягивается
   до момента, когда на оставшиеся этапы хватит ровно их времени. Чем быстрее
   закрыты карточки, тем длиннее разговор. */
var STAGE_MIN = { Words: 8, Story: 8, Retell: 12, Result: 12 };
var TALK_MIN = 10;                     /* короче этого Talk не бывает */
var REVIEW_MAX = 12;                   /* сколько ошибок подставлять в промпт */
var REVIEW_DAYS = 7;                   /* за сколько дней их брать */
var REVIEW_KEEP = 30;                  /* сколько дней разборов вообще хранить */
var WORDS_PER_DAY = 3;                 /* кандидатов в колоду за вечер */
var TALK_TAG = 'talk';                 /* тег карточек, пришедших из разговоров */

/* Этап разбора добавляет приложение, а не план: промпт один и тот же на все дни. */
var REVIEW_LABEL = 'Review';

/* Короткая реплика, когда собеседник поплыл: бросил список фраз, перестал
   исправлять или начал додумывать за меня. Вставляется в тот же чат. */
var ANCHOR_PROMPT =
  'Stop. Back to the rules. ' +
  'Repeat back only what I actually said \u2014 never guess my words. ' +
  'Correct every mistake I make, including in my questions. ' +
  'Name each mistake shortly first \u2014 wrong words, arrow, right words \u2014 ' +
  'then the reason in a few words. Do not repeat my whole long sentence back. ' +
  'Answer my questions directly, even when my English is broken. ' +
  'Continue the phrase list from where we stopped and say the number, like (3/10). ' +
  'Short turns. Continue now.';
var REVIEW_PROMPT =
  'Разбор без похвалы. Перечисли мои ошибки за сегодняшний разговор: ' +
  'грамматика (особенно past simple vs present perfect), неправильные глаголы, ' +
  'слова, которых я не знал и сказал по-русски. ' +
  'Формат каждой строки: моя ошибка \u2192 правильно. ' +
  'Без вступления и без комплиментов. ' +
  'В конце \u2014 3 слова или фразы, которые мне сегодня не хватило, ' +
  'по-английски с переводом.';
var FINISH_H = 22, FINISH_M = 58;      /* к этому времени вечер закрыт */

/* кнопки «Во сколько лёг»: индекс -> минуты от 22:00 */
var BED_MIN = [30, 60, 90, 120, 150];
var BED_LABEL = ['22:30', '23:00', '23:30', '00:00', 'позже'];

var DAYS = global.DAYS || [];
var CARDS = global.CARDS || [];

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function numAsc(a, b) { return a - b; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* ---------------------------------------------------------------- даты */

function dateNumOf(y, m, d) {
  return Math.round((Date.UTC(y, m, d) - BASE_UTC) / DAY_MS) + 1;
}

/* Логическая дата: Finish в 00:30 относится ко вчерашнему вечеру. */
function logicalDate(now) {
  var t = new Date(now.getTime() - CUTOFF_H * 3600000);
  return dateNumOf(t.getFullYear(), t.getMonth(), t.getDate());
}

function dateParts(n) {
  var d = new Date(BASE_UTC + (n - 1) * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
}

function dateISO(n) {
  var p = dateParts(n);
  return p.y + '-' + pad2(p.m + 1) + '-' + pad2(p.d);
}

function minutesToClock(min) {
  var t = Math.round(min) + 22 * 60;
  return pad2(Math.floor(t / 60) % 24) + ':' + pad2(t % 60);
}

/* ---------------------------------------------------------------- SM-2 */
/* Оценки: 0 Снова, 1 Трудно, 2 Хорошо, 3 Легко.
   Старт ease 2.50, интервалы 1 -> 6 -> interval * ease, «Снова» сбрасывает. */

function freshCard() { return { due: 0, ivl: 0, ef: 250, reps: 0, lapses: 0 }; }

function sm2(st, grade, today) {
  var s = { due: st.due, ivl: st.ivl, ef: st.ef, reps: st.reps, lapses: st.lapses };

  if (grade === 0) {
    s.reps = 0;
    s.ivl = 0;
    s.lapses += 1;
    s.ef = Math.max(130, s.ef - 20);
    s.due = today;                       /* вернётся в этой же очереди */
    return s;
  }

  if (grade === 1) s.ef = Math.max(130, s.ef - 15);
  else if (grade === 3) s.ef = Math.min(400, s.ef + 15);

  if (s.reps === 0) {
    s.ivl = (grade === 3) ? 3 : 1;
  } else if (s.reps === 1) {
    s.ivl = (grade === 1) ? 3 : (grade === 3 ? 8 : 6);
  } else {
    var f = (grade === 1) ? 1.2 : (grade === 3 ? (s.ef / 100) * 1.3 : s.ef / 100);
    s.ivl = Math.max(s.ivl + 1, Math.round(s.ivl * f));
  }
  s.reps += 1;
  if (s.ivl > MAX_IVL) s.ivl = MAX_IVL;
  s.due = today + s.ivl;
  return s;
}

/* ------------------------------------------------------------- очередь */

function newAllowance(state, today) {
  var used = (state.newDate === today) ? state.newCount : 0;
  return Math.max(0, NEW_PER_DAY - used);
}

/* Следующие невыданные карточки строго по порядку колоды. */
function pickNew(state, limit) {
  var out = [];
  var i = state.newScan || 0;
  while (i < CARDS.length && out.length < limit) {
    if (!state.cards[i]) out.push(i);
    i++;
  }
  return out;
}

/* Карточки из разговоров идут СВЕРХ дневных шести: иначе они съедали бы
   план, а он рассчитан ровно на 6 в день на все 168 вечеров. */
function pickNewTalk(state) {
  var out = [];
  var n = (state.extra || []).length;
  for (var k = 0; k < n && out.length < 6; k++) {
    var id = CARDS.length + k;
    if (!state.cards[id]) out.push(id);
  }
  return out;
}

function buildQueue(state, today) {
  var reviews = [];
  for (var k in state.cards) {
    if (!Object.prototype.hasOwnProperty.call(state.cards, k)) continue;
    if (state.cards[k].due <= today) reviews.push(+k);
  }
  reviews.sort(function (a, b) {
    var da = state.cards[a].due, db = state.cards[b].due;
    return da !== db ? da - db : a - b;
  });
  var news = pickNew(state, newAllowance(state, today)).concat(pickNewTalk(state));
  return { reviews: reviews, news: news, all: reviews.concat(news) };
}

/* Первый ответ по карточке = она «выдана». Считаем новые за дату. */
function registerAnswer(state, id, grade, today) {
  var isNew = !state.cards[id];
  var before = state.cards[id] || freshCard();
  state.cards[id] = sm2(before, grade, today);
  if (isNew && id < CARDS.length) {          /* карточки из разговоров лимит не тратят */
    if (state.newDate !== today) { state.newDate = today; state.newCount = 0; }
    state.newCount += 1;
    while (state.newScan < CARDS.length && state.cards[state.newScan]) state.newScan++;
  }
  return state.cards[id];
}


/* ------------------------------------------------- разбор ошибок за вечер */

var ARROW = /\s*(?:→|->)\s*/;

/* Текст от ChatGPT -> {mistakes, words}. Строки со стрелкой — ошибки,
   строки вида «english — перевод» в конце — кандидаты в карточки. */
function parseReview(text) {
  var out = { mistakes: [], words: [] };
  String(text || '').split('\n').forEach(function (raw) {
    var ln = raw.replace(/^[\s\-–—*•]+/, '').replace(/^\d+[.)]\s*/, '').trim();
    if (!ln) return;
    if (ARROW.test(ln)) {
      var p = ln.split(ARROW);
      var w = (p[0] || '').trim();
      var r = p.slice(1).join(' ').trim();
      if (w && r) out.mistakes.push({ w: w, r: r });
      return;
    }
    var m = /^([A-Za-z][A-Za-z'’\-\s,.()]{1,60}?)\s*[—–-]\s*([А-яЁё][^\n]{0,60})$/.exec(ln);
    if (m) out.words.push({ en: m[1].trim(), ru: m[2].trim() });
  });
  out.words = out.words.slice(-WORDS_PER_DAY);
  return out;
}

function reviewKey(w, r) {
  return (w + '→' + r).toLowerCase().replace(/\s+/g, ' ').trim();
}

/* Сохранить разбор за дату. Дубли не копятся, старое подрезается. */
function saveReview(state, dateNum, parsed) {
  var seen = {};
  (state.rev || []).forEach(function (x) { seen[reviewKey(x.w, x.r)] = 1; });
  var added = 0;
  parsed.mistakes.forEach(function (m) {
    var k = reviewKey(m.w, m.r);
    if (seen[k]) return;
    seen[k] = 1;
    state.rev.push({ d: dateNum, w: m.w, r: m.r });
    added++;
  });

  var have = {};
  (state.extra || []).forEach(function (x) { have[x.en.toLowerCase().trim()] = 1; });
  var CARDS_N = CARDS.length;
  var addedWords = 0;
  parsed.words.forEach(function (w) {
    if (addedWords >= WORDS_PER_DAY) return;
    var k = w.en.toLowerCase().trim();
    if (have[k]) return;
    /* фраза уже есть в плане — второй раз не нужна */
    for (var i = 0; i < CARDS_N; i++) {
      if (CARDS[i].en.toLowerCase() === k) return;
    }
    have[k] = 1;
    state.extra.push({ d: dateNum, en: w.en, ru: w.ru });
    addedWords++;
  });

  /* держим только последние REVIEW_KEEP дней разборов */
  state.rev = state.rev.filter(function (x) { return x.d > dateNum - REVIEW_KEEP; });
  return { mistakes: added, words: addedWords };
}

/* Свежие ошибки за последние REVIEW_DAYS дней, без дублей, не больше REVIEW_MAX. */
function recentMistakes(state, today) {
  var seen = {}, out = [];
  var list = (state.rev || []).slice().sort(function (a, b) { return b.d - a.d; });
  for (var i = 0; i < list.length && out.length < REVIEW_MAX; i++) {
    var x = list[i];
    if (x.d <= today - REVIEW_DAYS || x.d > today) continue;
    var k = reviewKey(x.w, x.r);
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(x);
  }
  return out;
}

/* Подставить накопленные ошибки в промпт первого этапа. Статичный список из
   плана остаётся: это диагноз с теста, а свежие ошибки идут в дополнение. */
function withMistakes(prompt, state, today) {
  var list = recentMistakes(state, today);
  if (!list.length) return prompt;
  var block = '\nMy recent mistakes from our last sessions (fix these first, every time):\n' +
    list.map(function (x) { return '- ' + x.w + ' → ' + x.r; }).join('\n') + '\n';
  var i = prompt.indexOf('\nRules:');
  return (i < 0) ? prompt + block : prompt.slice(0, i) + block + prompt.slice(i);
}

/* --------------------------------- колода = план + карточки из разговоров */

function cardCount(state) { return CARDS.length + ((state && state.extra) ? state.extra.length : 0); }

function cardAt(state, id) {
  if (id < CARDS.length) return CARDS[id];
  var x = state.extra[id - CARDS.length];
  if (!x) return null;
  return { id: id, n: id + 1, en: x.en, ru: x.ru, tag: TALK_TAG, day: 0, week: 0 };
}

/* ------------------------------------------------------------ статистика */

function countDoneIn(state, today, span) {
  var n = 0;
  for (var d = today - span + 1; d <= today; d++) if (state.fin[d] != null) n++;
  return n;
}

function streakDays(state, today) {
  var start = (state.fin[today] != null) ? today : today - 1;
  var n = 0;
  while (state.fin[start] != null) { n++; start--; }
  return n;
}

function avgIn(state, today, span, pick) {
  var sum = 0, n = 0;
  for (var d = today - span + 1; d <= today; d++) {
    var a = state.mrn[d];
    if (a) { sum += pick(a); n++; }
  }
  return n ? { avg: sum / n, n: n } : { avg: null, n: 0 };
}

function computeStats(state, today) {
  var learned = 0, inWork = 0;
  for (var k in state.cards) {
    if (!Object.prototype.hasOwnProperty.call(state.cards, k)) continue;
    inWork++;
    if (state.cards[k].ivl >= LEARNED_IVL) learned++;
  }
  var series = [];
  for (var d = today - 29; d <= today; d++) {
    var a = state.mrn[d];
    series.push({ date: d, speed: a ? a[0] : null, bed: a ? a[1] : null });
  }
  return {
    done7: countDoneIn(state, today, 7),
    done30: countDoneIn(state, today, 30),
    streak: streakDays(state, today),
    learned: learned,
    inWork: inWork,
    speed7: avgIn(state, today, 7, function (a) { return a[0]; }),
    speed30: avgIn(state, today, 30, function (a) { return a[0]; }),
    bed7: avgIn(state, today, 7, function (a) { return BED_MIN[a[1]]; }),
    bed30: avgIn(state, today, 30, function (a) { return BED_MIN[a[1]]; }),
    series: series
  };
}

/* ------------------------------------------ упаковка состояния в строку */

function b36(n) { return Math.round(n).toString(36); }
function p36(s) { var v = parseInt(s, 36); return isFinite(v) ? v : 0; }

function blankState() {
  return {
    day: 1, sound: true, newScan: 0, newDate: 0, newCount: 0, cpDate: 0,
    evDate: 0, evStage: 0, evEnd: 0,
    fin: {}, mrn: {}, cards: {},
    rev: [],                 /* [{d, w, r}] — дата, ошибка, как правильно */
    extra: []                /* [{d, en, ru}] — карточки из разговоров */
  };
}

function encodeState(s) {
  var head = [s.day, s.sound ? 1 : 0, s.newScan, s.newDate, s.newCount, s.cpDate || 0,
              s.evDate || 0, s.evStage || 0, s.evEnd || 0].map(b36).join(',');

  var fin = Object.keys(s.fin).map(Number).sort(numAsc).map(function (d) {
    return b36(d) + ',' + b36(s.fin[d]);
  }).join(';');

  var mrn = Object.keys(s.mrn).map(Number).sort(numAsc).map(function (d) {
    return b36(d) + ',' + b36(s.mrn[d][0]) + ',' + b36(s.mrn[d][1]);
  }).join(';');

  var crd = Object.keys(s.cards).map(Number).sort(numAsc).map(function (i) {
    var c = s.cards[i];
    return b36(i) + ',' + b36(c.due) + ',' + b36(c.ivl) + ',' +
           b36(c.ef) + ',' + b36(c.reps) + ',' + b36(c.lapses);
  }).join(';');

  var rev = (s.rev || []).map(function (x) {
    return b36(x.d) + ',' + enc(x.w) + ',' + enc(x.r);
  }).join(';');

  var ext = (s.extra || []).map(function (x) {
    return b36(x.d) + ',' + enc(x.en) + ',' + enc(x.ru);
  }).join(';');

  return [STATE_V, head, fin, mrn, crd, rev, ext].join('\n');
}

/* encodeURIComponent экранирует и запятую, и точку с запятой, и перевод строки —
   ровно те символы, которыми разделены поля. */
function enc(t) { return encodeURIComponent(String(t == null ? '' : t)); }
function dec(t) { try { return decodeURIComponent(t); } catch (e) { return t; } }

function decodeState(str) {
  if (typeof str !== 'string' || !str) throw new Error('пустое состояние');
  var parts = str.split('\n');
  /* 5 секций — состояние до появления разбора ошибок; принимаем и дополняем */
  if (parts.length === 5) parts = parts.concat(['', '']);
  if (parts.length !== 7) throw new Error('ожидалось 7 секций, получено ' + parts.length);
  if (p36(parts[0]) !== STATE_V) throw new Error('версия состояния ' + parts[0] + ', поддерживается ' + STATE_V);

  var s = blankState();
  var h = parts[1].split(',');
  /* 6 полей — заголовок до появления этапов разговора */
  if (h.length === 6) h = h.concat(['0', '0', '0']);
  if (h.length !== 9) throw new Error('повреждён заголовок состояния');
  s.day = clamp(p36(h[0]) || 1, 1, TOTAL_DAYS);
  s.sound = p36(h[1]) !== 0;
  s.newScan = Math.max(0, p36(h[2]));
  s.newDate = Math.max(0, p36(h[3]));
  s.newCount = Math.max(0, p36(h[4]));
  s.cpDate = Math.max(0, p36(h[5]));
  s.evDate = Math.max(0, p36(h[6]));
  s.evStage = Math.max(0, p36(h[7]));
  s.evEnd = Math.max(0, p36(h[8]));

  if (parts[2]) parts[2].split(';').forEach(function (chunk) {
    var a = chunk.split(',');
    if (a.length !== 2) throw new Error('повреждена запись сделанного дня: ' + chunk);
    s.fin[p36(a[0])] = p36(a[1]);
  });

  if (parts[3]) parts[3].split(';').forEach(function (chunk) {
    var a = chunk.split(',');
    if (a.length !== 3) throw new Error('повреждена запись утра: ' + chunk);
    s.mrn[p36(a[0])] = [clamp(p36(a[1]), 1, 5), clamp(p36(a[2]), 0, BED_MIN.length - 1)];
  });

  if (parts[4]) parts[4].split(';').forEach(function (chunk) {
    var a = chunk.split(',');
    if (a.length !== 6) throw new Error('повреждена запись карточки: ' + chunk);
    var id = p36(a[0]);
    if (id < 0 || id >= CARDS.length + s.extra.length)
      throw new Error('карточка вне колоды: ' + id);
    s.cards[id] = {
      due: p36(a[1]), ivl: p36(a[2]),
      ef: clamp(p36(a[3]) || 250, 130, 400),
      reps: p36(a[4]), lapses: p36(a[5])
    };
  });

  if (parts[5]) parts[5].split(';').forEach(function (chunk) {
    var a = chunk.split(',');
    if (a.length !== 3) throw new Error('повреждена запись разбора: ' + chunk);
    s.rev.push({ d: p36(a[0]), w: dec(a[1]), r: dec(a[2]) });
  });

  if (parts[6]) parts[6].split(';').forEach(function (chunk) {
    var a = chunk.split(',');
    if (a.length !== 3) throw new Error('повреждена запись карточки из разговора: ' + chunk);
    s.extra.push({ d: p36(a[0]), en: dec(a[1]), ru: dec(a[2]) });
  });

  /* newScan — только подсказка, восстанавливаем честно */
  s.newScan = 0;
  while (s.newScan < CARDS.length && s.cards[s.newScan]) s.newScan++;
  return s;
}

function checksum(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

/* =====================================================================
   2. ХРАНИЛИЩЕ
   Состояние пакуется в строку, режется на куски по 3500 символов
   (лимит значения CloudStorage — 4096 байт, строка чисто ASCII).
   Пишем в «теневое» поколение ключей, затем одним ключом переключаем
   манифест — запись атомарна, обрыв не портит сохранённое.
   ===================================================================== */

var Store = (function () {
  var CHUNK = 3500;
  var MANIFEST = 'm';
  var tg = null;
  var mem = {};                 /* запасной вариант: localStorage / память */

  function cloud() {
    if (!tg || !tg.CloudStorage) return null;
    if (tg.isVersionAtLeast && !tg.isVersionAtLeast('6.9')) return null;
    return tg.CloudStorage;
  }

  function lsGet(k) {
    try { return global.localStorage ? global.localStorage.getItem('ee_' + k) : mem[k] || null; }
    catch (e) { return mem[k] || null; }
  }
  function lsSet(k, v) {
    mem[k] = v;
    try { if (global.localStorage) global.localStorage.setItem('ee_' + k, v); } catch (e) {}
  }

  function getItems(keys, cb) {
    var cs = cloud();
    if (!cs) {
      var out = {};
      keys.forEach(function (k) { out[k] = lsGet(k); });
      return setTimeout(function () { cb(null, out); }, 0);
    }
    cs.getItems(keys, function (err, vals) { cb(err || null, vals || {}); });
  }

  function setItems(pairs, cb) {
    var cs = cloud();
    var keys = Object.keys(pairs);
    if (!keys.length) return cb(null);
    if (!cs) {
      keys.forEach(function (k) { lsSet(k, pairs[k]); });
      return setTimeout(function () { cb(null); }, 0);
    }
    var left = keys.length, failed = null;
    keys.forEach(function (k) {
      cs.setItem(k, pairs[k], function (err, ok) {
        if (err || ok === false) failed = err || new Error('CloudStorage отказал на ключе ' + k);
        if (--left === 0) cb(failed);
      });
    });
  }

  function split(str) {
    var out = [];
    for (var i = 0; i < str.length; i += CHUNK) out.push(str.slice(i, i + CHUNK));
    return out.length ? out : [''];
  }

  function manifestFor(gen, chunks, str) {
    return { g: gen, n: chunks.length, len: str.length, ck: checksum(str) };
  }

  function assemble(man, vals) {
    var parts = [];
    for (var i = 0; i < man.n; i++) {
      var v = vals[man.g + i];
      if (v == null) return null;
      parts.push(v);
    }
    var str = parts.join('');
    if (str.length !== man.len || checksum(str) !== man.ck) return null;
    return str;
  }

  var current = null;           /* последний успешно записанный манифест */
  var pending = null, timer = null, inFlight = false, again = false;

  function writeNow(state, done) {
    var str = encodeState(state);
    var gen = (current && current.g === 'a') ? 'b' : 'a';
    var chunks = split(str);
    var man = manifestFor(gen, chunks, str);

    var pairs = {};
    chunks.forEach(function (c, i) { pairs[gen + i] = c; });

    inFlight = true;
    setItems(pairs, function (err) {
      if (err) { inFlight = false; return done && done(err); }
      var payload = { g: man.g, n: man.n, len: man.len, ck: man.ck };
      if (current) payload.p = { g: current.g, n: current.n, len: current.len, ck: current.ck };
      setItems({ m: JSON.stringify(payload) }, function (err2) {
        inFlight = false;
        if (!err2) current = man;
        if (again) { again = false; schedule(pending, 0); }
        done && done(err2 || null);
      });
    });
  }

  function schedule(state, delay) {
    pending = state;
    if (inFlight) { again = true; return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; writeNow(pending); }, delay);
  }

  return {
    attach: function (t) { tg = t; },

    load: function (cb) {
      getItems([MANIFEST], function (err, vals) {
        if (err || !vals[MANIFEST]) return cb(null, blankState(), 'new');
        var man;
        try { man = JSON.parse(vals[MANIFEST]); } catch (e) { return cb(null, blankState(), 'new'); }
        if (!man || !man.g || !man.n) return cb(null, blankState(), 'new');

        var keys = [], i;
        for (i = 0; i < man.n; i++) keys.push(man.g + i);
        if (man.p) for (i = 0; i < man.p.n; i++) keys.push(man.p.g + i);

        getItems(keys, function (err2, vals2) {
          if (err2) return cb(err2, blankState(), 'error');
          var str = assemble(man, vals2);
          var used = man;
          if (str == null && man.p) { str = assemble(man.p, vals2); used = man.p; }
          if (str == null) return cb(null, blankState(), 'corrupt');
          try {
            var st = decodeState(str);
            current = used;
            return cb(null, st, used === man ? 'ok' : 'recovered');
          } catch (e) {
            return cb(null, blankState(), 'corrupt');
          }
        });
      });
    },

    save: function (state, force, done) {
      if (force) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (inFlight) { pending = state; again = true; return done && done(null); }
        return writeNow(state, done);
      }
      schedule(state, 2500);
    },

    /* для проверки лимитов в настройках */
    describe: function (state) {
      var str = encodeState(state);
      var n = split(str).length;
      return { bytes: str.length, chunks: n, keys: n * 2 + 1, cloud: !!cloud() };
    }
  };
})();

/* =====================================================================
   3. ЗВУК  — короткие синтезированные тона, без внешних файлов
   ===================================================================== */

var Sound = (function () {
  var ctx = null, on = true;

  function ac() {
    if (ctx) return ctx;
    var C = global.AudioContext || global.webkitAudioContext;
    if (!C) return null;
    try { ctx = new C(); } catch (e) { return null; }
    return ctx;
  }

  function beep(freq, at, dur, vol, type) {
    var c = ac();
    if (!c) return;
    var t0 = c.currentTime + at;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  function play(notes) {
    if (!on) return;
    var c = ac();
    if (!c) return;
    if (c.state === 'suspended' && c.resume) c.resume();
    notes.forEach(function (n) { beep(n[0], n[1], n[2], n[3], n[4]); });
  }

  return {
    setOn: function (v) { on = !!v; },
    isOn: function () { return on; },
    unlock: function () { var c = ac(); if (c && c.state === 'suspended' && c.resume) c.resume(); },
    tap:    function () { play([[520, 0, 0.05, 0.05]]); },
    flip:   function () { play([[430, 0, 0.07, 0.055]]); },
    good:   function () { play([[660, 0, 0.09, 0.07], [880, 0.07, 0.11, 0.055]]); },
    again:  function () { play([[300, 0, 0.13, 0.06, 'triangle']]); },
    done:   function () { play([[523, 0, 0.12, 0.06], [659, 0.1, 0.12, 0.06], [784, 0.2, 0.26, 0.055]]); },
    finish: function () {
      play([[392, 0, 0.35, 0.055], [294, 0.3, 0.4, 0.05], [196, 0.65, 0.9, 0.045]]);
    }
  };
})();

/* =====================================================================
   4. ИНТЕРФЕЙС
   ===================================================================== */

var S = blankState();       /* состояние */
var TODAY = 0;              /* логическая дата */
var tab = 'today';
var tg = null;
var dayTotal = 0;           /* размер очереди на начало сессии карточек */
var deferred = [];          /* карточки, по которым нажали «Снова» */
var flipped = false;
var pendingMorning = { speed: null, bed: null };
var curtainDismissed = false;   /* занавес закрыли тапом — показываем «Сегодня закрыто» */

function el(id) { return global.document.getElementById(id); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
  });
}

var MON_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
              'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function humanDate(n) {
  var p = dateParts(n);
  return p.d + ' ' + MON_RU[p.m];
}

function dayByNumber(n) {
  for (var i = 0; i < DAYS.length; i++) if (DAYS[i].n === n) return DAYS[i];
  return null;
}

function plural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}


/* Значки тем по неделям плана. Рисуем линиями через currentColor: вектор,
   масштабируется, красится темой, ничего не грузится из сети.
   Колода на 88% — грамматические обороты и связки («In spite of that, ...»),
   их нарисовать нельзя, поэтому значок показывает тему недели, а не фразу. */
var ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

var WEEK_ICONS = {
  1:  '<rect x="3.5" y="8" width="17" height="11.5" rx="2"/><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M12 8v11.5"/>',
  2:  '<circle cx="12" cy="12" r="8.2"/><path d="M8.3 12.3l2.6 2.6 4.8-5.2"/>',
  3:  '<path d="M7 15.5a3.6 3.6 0 0 1 .5-7.15 4.7 4.7 0 0 1 8.9 1.35A3.2 3.2 0 0 1 16.6 15.5z"/><path d="M9 18.5v1.6M12 18.5v2.2M15 18.5v1.6"/>',
  4:  '<path d="M12 20s-7-4.4-7-9.2A3.7 3.7 0 0 1 12 8.2a3.7 3.7 0 0 1 7 2.6C19 15.6 12 20 12 20z"/>',
  5:  '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.2V12l3.3 2"/>',
  6:  '<rect x="4" y="5.5" width="16" height="11" rx="1.8"/><path d="M2.5 19.5h19"/>',
  7:  '<path d="M12 6.8C10.8 5.7 9 5.2 6.4 5.2H3.8v12.6h2.6c2.6 0 4.4.5 5.6 1.6 1.2-1.1 3-1.6 5.6-1.6h2.6V5.2h-2.6c-2.6 0-4.4.5-5.6 1.6z"/><path d="M12 6.8v12.6"/>',
  8:  '<rect x="5" y="4.2" width="14" height="16.6" rx="2"/><rect x="9" y="2.2" width="6" height="4" rx="1.2"/><path d="M8.6 11.5h6.8M8.6 15.2h4.2"/>',
  9:  '<circle cx="12" cy="12" r="8.2"/><path d="M9.7 9.8a2.4 2.4 0 1 1 3.2 2.3c-.6.3-.9.8-.9 1.4v.5"/><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"/>',
  10: '<path d="M3.2 20.5h17.6"/><rect x="4" y="10" width="6" height="10.5"/><rect x="13" y="4.5" width="7" height="16"/><path d="M6 13h2M6 16h2M15.2 8h2.6M15.2 11.5h2.6M15.2 15h2.6"/>',
  11: '<path d="M4.5 10.5A7.6 7.6 0 0 1 18 8"/><path d="M4.5 6.5v4h4"/><path d="M19.5 13.5A7.6 7.6 0 0 1 6 16"/><path d="M19.5 17.5v-4h-4"/>',
  12: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  13: '<circle cx="9.5" cy="9" r="3.2"/><path d="M9.5 3.2v1.4M9.5 13.4v1.4M3.7 9h1.4M13.9 9h1.4M5.4 4.9l1 1M12.6 12.1l1 1M13.6 4.9l-1 1M6.4 12.1l-1 1"/><path d="M11.5 20.5a3.4 3.4 0 0 1 .4-6.77 4.4 4.4 0 0 1 8.35 1.27A3 3 0 0 1 19.7 20.5z"/>',
  14: '<path d="M12 21v-7"/><path d="M12 14L6.4 8.4"/><path d="M12 14l5.6-5.6"/><path d="M6.4 8.4h3.4M6.4 8.4v3.4"/><path d="M17.6 8.4h-3.4M17.6 8.4v3.4"/>',
  15: '<circle cx="12" cy="8.2" r="3.6"/><path d="M5.2 20.3a6.8 6.8 0 0 1 13.6 0"/>',
  16: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><path d="M10 15.5h5M13 13.2l2.3 2.3-2.3 2.3"/>',
  17: '<path d="M3.5 6.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-3.5 2.8V12.5a2 2 0 0 1-1-1.7z"/><path d="M18 9.5h.5a2 2 0 0 1 2 2v4a2 2 0 0 1-1 1.7v2.6L16 17h-3"/>',
  18: '<path d="M4.5 12a7.6 7.6 0 1 0 2.3-5.4"/><path d="M3.5 4.5v4.2h4.2"/><path d="M12 8.4V12l2.6 1.8"/>',
  19: '<path d="M12 4.2v16.3M7 20.5h10"/><path d="M4 9.5h16"/><path d="M4 9.5L1.8 14a2.6 2.6 0 0 0 4.4 0z"/><path d="M20 9.5L17.8 14a2.6 2.6 0 0 0 4.4 0z"/>',
  20: '<path d="M4.5 12a7.5 7.5 0 0 1 15 0"/><rect x="2.8" y="12" width="3.6" height="5.6" rx="1.6"/><rect x="17.6" y="12" width="3.6" height="5.6" rx="1.6"/><path d="M19.4 17.6v.9a2.4 2.4 0 0 1-2.4 2.4h-2.6"/>',
  21: '<path d="M2.8 18.6h18.4"/><path d="M7.4 18.6a4.6 4.6 0 0 1 9.2 0"/><path d="M12 5v2.5M5.6 7.6l1.8 1.8M18.4 7.6l-1.8 1.8M2.6 13.9h2.3M19.1 13.9h2.3"/>',
  22: '<ellipse cx="12" cy="6.6" rx="7" ry="2.6"/><path d="M5 6.6v4.4c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6V6.6"/><path d="M5 11v4.4c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6V11"/>',
  23: '<path d="M3.5 20.5h17"/><rect x="4.5" y="12" width="4.6" height="8.5"/><rect x="14.9" y="6" width="4.6" height="14.5"/><path d="M11.8 9.5h1M11.8 13h1M11.8 16.5h1"/>',
  24: '<path d="M2.8 18.5l5.4-8.2 3.4 4.6 2.6-3.4 7 7z"/><path d="M6.6 5.2v5.6"/><path d="M6.6 5.2l4.2 1.3-4.2 1.4"/>'
};

function weekIcon(week) {
  var body = WEEK_ICONS[week];
  if (!body) return '';
  return '<svg class="flash__icon" ' + ICON_ATTRS + ' aria-hidden="true">' + body + '</svg>';
}

var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
  'd="M9.6 17.2 4.4 12l1.6-1.6 3.6 3.6 8-8L19.2 7.6 9.6 17.2Z"/></svg>';


/* ------------------------------------------------- длительности этапов */

/* Сколько минут занимают этапы ПОСЛЕ указанного. Talk считается по минимуму:
   он и так растягивается, но занять меньше TALK_MIN не может. */
function minutesAfter(stages, idx) {
  var sum = 0;
  for (var i = idx + 1; i < stages.length; i++) {
    var l = stages[i].label;
    if (l === REVIEW_LABEL) continue;           /* разбор без таймера */
    sum += (l === 'Talk') ? TALK_MIN : (STAGE_MIN[l] || 10);
  }
  return sum;
}

/* Длительность этапа в миллисекундах на момент его запуска. */
function stageDuration(stages, idx, now) {
  var label = stages[idx].label;
  if (label === REVIEW_LABEL) return 0;
  if (label !== 'Talk') return (STAGE_MIN[label] || 10) * 60000;

  var end = new Date(now.getTime());
  end.setHours(FINISH_H, FINISH_M, 0, 0);
  if (now.getHours() < CUTOFF_H) end.setDate(end.getDate() - 1);   /* после полуночи */
  var target = end.getTime() - minutesAfter(stages, idx) * 60000;
  return Math.max(TALK_MIN * 60000, target - now.getTime());
}

function dayStages(d) {
  var base = (d && d.stages && d.stages.length) ? d.stages : [];
  /* LIGHT-вечер разбирать нечего: там задача заснуть под рассказ */
  if (base.length < 2) return base;
  return base.concat([{ label: REVIEW_LABEL, prompt: REVIEW_PROMPT }]);
}

/* У LIGHT-вечера один этап и он без таймера: там задача — заснуть. */
function stageHasTimer(stages) { return stages.length > 1; }

/* ------------------------------------------------------------- вкладки */

function go(name) {
  tab = name;
  ['today', 'cards', 'morning', 'progress'].forEach(function (t) {
    el('screen-' + t).hidden = (t !== name);
  });
  var tabs = el('tabbar').querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-go') === name);
  }
  el('topTitle').textContent =
    { today: 'Сегодня', cards: 'Карточки', morning: 'Утро', progress: 'Прогресс' }[name];
  render();
}

function render() {
  if (tab === 'today') renderToday();
  else if (tab === 'cards') renderCards();
  else if (tab === 'morning') renderMorning(el('morningBody'), false);
  else renderProgress();
}

/* --------------------------------------------------------------- утро? */

function morningTarget() { return TODAY - 1; }

/* Спрашиваем, только если вчера был закрытый вечер и ответа ещё нет.
   В вечерние часы вопрос не мешает — вкладка сразу показывает вечер. */
function needMorning() {
  var t = morningTarget();
  if (S.mrn[t]) return false;
  if (S.fin[t] == null) return false;
  return new Date().getHours() < EVENING_H;
}

/* ------------------------------------------------------------- СЕГОДНЯ */

function isNight() {
  var h = new Date().getHours();
  return h >= EVENING_H - 1 || h < CUTOFF_H;
}

function renderToday() {
  var box = el('todayBody');

  if (needMorning()) { renderMorning(box, true); return; }

  if (S.fin[TODAY] != null) {
    if (isNight() && !curtainDismissed) { showCurtain(false); return; }
    box.innerHTML =
      '<div class="gap-xl center stack">' +
        '<div class="h1">Сегодня закрыто</div>' +
        '<p class="sub">День ' + esc(S.fin[TODAY]) + ' сделан. ' +
        'Следующий откроется завтра.</p>' +
      '</div>';
    return;
  }

  var d = dayByNumber(S.day);
  if (!d) {
    box.innerHTML = '<div class="gap-xl center stack"><div class="h1">План пройден</div>' +
      '<p class="sub">168 вечеров позади.</p></div>';
    return;
  }

  var q = buildQueue(S, TODAY);
  var left = q.all.length;
  var cardsDone = left === 0;
  var promptDone = (S.evDate === TODAY && S.evStage > stagesCount(d));

  var stages = dayStages(d);
  var conv = renderConversation(d, stages);

  box.innerHTML =
    '<div class="chip">' + esc(d.type) + ' · ' + esc(d.typeLabel) + '</div>' +
    '<div class="h1">День ' + d.n + '</div>' +
    '<p class="sub">Неделя ' + d.week + ' · ' + esc(d.weekday.toLowerCase()) + '</p>' +

    '<div class="panel gap-lg">' +
      '<p class="tiny faint">ТЕМА</p>' +
      '<p style="margin:2px 0 0;font-size:17px">' + esc(d.topic) + '</p>' +
      '<p class="tiny faint" style="margin-top:14px">ГРАММАТИКА НЕДЕЛИ</p>' +
      '<p style="margin:2px 0 0;font-size:15px" class="dim">' + esc(d.grammar) + '</p>' +
    '</div>' +

    '<div class="gap-lg">' +

      '<div class="step' + (cardsDone ? ' is-done' : '') + '">' +
        '<span class="step__mark">' + CHECK_SVG + '</span>' +
        '<div class="step__body">' +
          '<p class="step__title">Карточки</p>' +
          '<p class="step__note">' +
            (cardsDone ? 'Очередь на сегодня пуста'
                       : q.news.length + ' ' + plural(q.news.length, 'новая', 'новых', 'новых') +
                         ' · ' + q.reviews.length + ' ' +
                         plural(q.reviews.length, 'повтор', 'повтора', 'повторов')) +
          '</p>' +
          (cardsDone ? '' :
            '<button class="btn btn--sm" style="margin-top:12px" data-act="open-cards">Открыть карточки</button>') +
        '</div>' +
      '</div>' +

      '<div class="step' + (promptDone ? ' is-done' : '') + '">' +
        '<span class="step__mark">' + CHECK_SVG + '</span>' +
        '<div class="step__body">' +
          '<p class="step__title">Разговор</p>' +
          conv +
        '</div>' +
      '</div>' +

      '<div class="step">' +
        '<span class="step__mark">' + CHECK_SVG + '</span>' +
        '<div class="step__body">' +
          '<p class="step__title">Finish</p>' +
          '<p class="step__note">Закрыть вечер и выключить свет</p>' +
          '<button class="btn btn--big" style="margin-top:14px" data-act="finish">Finish</button>' +
        '</div>' +
      '</div>' +

    '</div>';
}


/* ------------------------------------------------------ экран разговора */

function stagesCount(d) { return dayStages(d).length; }

/* Индекс текущего этапа: 0 — ещё не начинали. */
function currentStage() {
  return (S.evDate === TODAY) ? S.evStage : 0;
}

function stageRunning() {
  return S.evDate === TODAY && S.evEnd > 0 && Date.now() < S.evEnd * 1000;
}

function renderConversation(d, stages) {
  if (!stages.length) return '<p class="step__note">У этого вечера нет этапов.</p>';

  var idx = currentStage();

  /* разговор ещё не начат */
  if (idx === 0) {
    var left = buildQueue(S, TODAY).all.length;
    return '<p class="step__note">' + stages.length + ' ' +
      plural(stages.length, 'этап', 'этапа', 'этапов') + ': ' +
      stages.map(function (x) { return esc(x.label); }).join(' → ') + '</p>' +
      (left ? '<p class="tiny faint" style="margin-top:8px">Сначала карточки — их ' + left + '</p>' : '') +
      '<button class="btn btn--accent" style="margin-top:12px" data-act="conv-start">' +
        'Начать разговор</button>';
  }

  /* все этапы пройдены */
  if (idx > stages.length) {
    return '<p class="step__note">Все этапы пройдены. Скажи «Finish».</p>';
  }

  var st = stages[idx - 1];
  var running = stageRunning();
  var timed = stageHasTimer(stages) && st.label !== REVIEW_LABEL;

  if (st.label === REVIEW_LABEL) {
    var saved = reviewSavedToday();
    return '<p class="step__note">Этап ' + idx + ' из ' + stages.length + ' · Разбор</p>' +
      '<button class="btn btn--accent" style="margin-top:12px" data-act="copy-stage">' +
        'Скопировать промпт разбора</button>' +
      '<div id="copyBox"></div>' +
      '<p class="tiny faint" style="margin-top:10px">Вставь в тот же чат. ' +
        'Потом скопируй ответ сюда — ошибки уйдут в промпты следующих вечеров.</p>' +
      (saved
        ? '<p class="note note--ok">Разбор за сегодня сохранён: ' + saved.m + ' ' +
            plural(saved.m, 'ошибка', 'ошибки', 'ошибок') + ', ' + saved.w + ' ' +
            plural(saved.w, 'карточка', 'карточки', 'карточек') + '.</p>'
        : '<textarea class="ta" id="revArea" spellcheck="false" ' +
            'placeholder="Вставь разбор от ChatGPT сюда"></textarea>' +
          '<div class="btn-row" style="margin-top:8px">' +
            '<button class="btn btn--sm" data-act="save-review">Сохранить</button>' +
            '<button class="btn btn--sm btn--ghost" data-act="conv-next">Пропустить</button>' +
          '</div>' +
          '<div id="revNote"></div>') +
      (saved ? '<button class="btn btn--sm btn--ghost" style="margin-top:12px" ' +
                 'data-act="conv-next">Дальше</button>' : '');
  }

  return '<p class="step__note">Этап ' + idx + ' из ' + stages.length + ' · ' + esc(st.label) + '</p>' +
    '<button class="btn btn--accent" style="margin-top:12px" data-act="copy-stage">' +
      'Скопировать ' + esc(st.label) + '</button>' +
    '<div id="copyBox"></div>' +
    (idx === 1
      ? '<p class="tiny faint" style="margin-top:10px">Новый чат в ChatGPT → вставить → включить голос → телефон экраном вниз.<br>' +
        'Все этапы вставляются <b>в один и тот же чат</b>.</p>'
      : '<p class="tiny faint" style="margin-top:10px">Вставь в тот же чат, что и раньше.</p>') +
    '<button class="btn btn--sm btn--ghost" style="margin-top:8px" data-act="copy-anchor">' +
      'Поплыл — вернуть в русло</button>' +
    (timed
      ? '<p class="tiny faint" style="margin-top:8px">' +
          (running ? 'Идёт. Прозвучит сигнал, когда этап закончится.'
                   : 'Этап отсчитан. Нажми, когда будешь готов дальше.') + '</p>'
      : '') +
    '<div class="btn-row" style="margin-top:12px">' +
      (idx < stages.length
        ? '<button class="btn btn--sm" data-act="conv-next">' +
            (idx + 1 <= stages.length ? 'Дальше: ' + esc(stages[idx].label) : 'Дальше') + '</button>'
        : '<button class="btn btn--sm" data-act="conv-next">Закончить этапы</button>') +
    '</div>';
}


/* Сколько сохранено за сегодня — чтобы не предлагать сохранить дважды. */
function reviewSavedToday() {
  var m = 0, w = 0;
  (S.rev || []).forEach(function (x) { if (x.d === TODAY) m++; });
  (S.extra || []).forEach(function (x) { if (x.d === TODAY) w++; });
  return (m || w) ? { m: m, w: w } : null;
}

function onSaveReview() {
  var area = el('revArea');
  var note = el('revNote');
  if (!area) return;
  var text = (area.value || '').trim();
  if (!text) {
    if (note) note.innerHTML = '<p class="note">Пусто. Можно пропустить — вечер это не сломает.</p>';
    return;
  }
  var parsed = parseReview(text);
  if (!parsed.mistakes.length && !parsed.words.length) {
    if (note) note.innerHTML = '<p class="note note--warn">Не нашёл ни одной строки со стрелкой. ' +
      'Формат: ошибка \u2192 правильно.</p>';
    Sound.again();
    return;
  }
  var res = saveReview(S, TODAY, parsed);
  Store.save(S, true);
  Sound.good();
  renderToday();
}

/* ---- таймер этапа: без обратного отсчёта на экране ---- */

var stageTimer = null;

function armStageTimer() {
  if (stageTimer) { clearTimeout(stageTimer); stageTimer = null; }
  if (!stageRunning()) return;
  var ms = S.evEnd * 1000 - Date.now();
  stageTimer = setTimeout(function () {
    stageTimer = null;
    Sound.done();
    buzz();
    if (tab === 'today') renderToday();
  }, Math.max(0, ms));
}

/* Вибрация в конце этапа: телефон лежит экраном вниз, звука может не хватить. */
function buzz() {
  try {
    if (tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred('success');
      return;
    }
  } catch (e) {}
  try { if (global.navigator && global.navigator.vibrate) global.navigator.vibrate([90, 70, 90]); } catch (e) {}
}

function startStage(idx) {
  var d = dayByNumber(S.day);
  var stages = dayStages(d);
  /* stages.length + 1 — состояние «все этапы пройдены», оно допустимо */
  if (!stages.length || idx > stages.length + 1) return;
  S.evDate = TODAY;
  S.evStage = idx;
  if (idx >= 1 && idx <= stages.length && stageHasTimer(stages)) {
    var ms = stageDuration(stages, idx - 1, new Date());
    S.evEnd = Math.round((Date.now() + ms) / 1000);
  } else {
    S.evEnd = 0;
  }
  Store.save(S, true);
  armStageTimer();
  renderToday();
}

function onCopyStage() {
  var d = dayByNumber(S.day);
  var stages = dayStages(d);
  var idx = currentStage();
  if (!stages.length || idx < 1 || idx > stages.length) return;
  var text = stages[idx - 1].prompt;
  if (idx === 1) text = withMistakes(text, S, TODAY);
  copyText(text, function (ok) {
    S.cpDate = TODAY;
    Store.save(S, true);
    if (ok) Sound.good(); else Sound.again();
    if (tab === 'today') renderToday();
    if (ok) return;
    var box = el('copyBox');
    if (!box) return;
    box.innerHTML =
      '<p class="note note--warn">Буфер обмена недоступен. Текст выделен — скопируй вручную:</p>' +
      '<textarea class="ta" id="copyArea" spellcheck="false"></textarea>';
    var area = el('copyArea');
    area.value = text;
    area.focus();
    area.setSelectionRange(0, text.length);
  });
}

/* ------------------------------------------------------ копирование промпта */

function copyText(text, cb) {
  var nav = global.navigator;
  if (nav && nav.clipboard && nav.clipboard.writeText) {
    try {
      nav.clipboard.writeText(text).then(function () { cb(true); }, function () { legacyCopy(text, cb); });
      return;
    } catch (e) { /* дальше */ }
  }
  legacyCopy(text, cb);
}

function legacyCopy(text, cb) {
  var doc = global.document;
  var ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px';
  doc.body.appendChild(ta);
  var ok = false;
  try {
    ta.contentEditable = 'true';
    ta.readOnly = false;
    var range = doc.createRange();
    range.selectNodeContents(ta);
    var sel = global.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy');
  } catch (e) { ok = false; }
  doc.body.removeChild(ta);
  cb(!!ok);
}

/* --------------------------------------------------------------- FINISH */

function doFinish() {
  if (S.fin[TODAY] != null) return;
  S.fin[TODAY] = S.day;
  S.day = Math.min(TOTAL_DAYS, S.day + 1);
  S.evDate = 0; S.evStage = 0; S.evEnd = 0;
  if (stageTimer) { clearTimeout(stageTimer); stageTimer = null; }
  Sound.finish();
  Store.save(S, true);
  showCurtain(true);
  reportToBot();
}

/* Тихо отдать боту сводку, чтобы /today и /stats были свежими без ручного экспорта.
   sendData работает, только если приложение открыто кнопкой клавиатуры, и закрывает
   приложение — поэтому ждём, пока догорит «Спокойной ночи». Не вышло — не беда,
   вечер уже записан в CloudStorage. */
function reportToBot() {
  if (!tg || typeof tg.sendData !== 'function') return;
  var msg;
  try {
    msg = JSON.stringify({
      app: 'english-evenings', v: STATE_V, auto: true,
      exported: new Date().toISOString(),
      summary: exportSummary()
    });
  } catch (e) { return; }
  if (utf8len(msg) > 4096) return;
  setTimeout(function () {
    try { tg.sendData(msg); } catch (e) {}
  }, 3500);
}

var curtainAt = 0;

/* показать/снять ночной занавес: «Спокойной ночи» поверх всего */
function curtain(show, fresh) {
  el('curtain').hidden = !show;
  el('tabbar').style.display = show ? 'none' : '';
  el('screens').style.visibility = show ? 'hidden' : '';
  el('btnSettings').style.display = show ? 'none' : '';
  if (show) {
    curtainAt = Date.now();
    if (!fresh) el('curtain').style.animation = 'none';
  } else {
    el('curtain').style.animation = '';
  }
}

function showCurtain(fresh) { curtain(true, fresh); }


/* ------------------------------------------------------------ КАРТОЧКИ */

var dayTotal_date = 0;
var doneSound_date = 0;

function orderedQueue() {
  var q = buildQueue(S, TODAY).all;
  if (!deferred.length) return q;
  var rank = {}, i;
  for (i = 0; i < deferred.length; i++) rank[deferred[i]] = i + 1;
  var head = [], tail = [];
  for (i = 0; i < q.length; i++) (rank[q[i]] ? tail : head).push(q[i]);
  tail.sort(function (a, b) { return rank[a] - rank[b]; });
  return head.concat(tail);
}

function syncDayTotal(len) {
  if (dayTotal_date !== TODAY) { dayTotal_date = TODAY; dayTotal = len; deferred = []; }
  if (len > dayTotal) dayTotal = len;
}

function renderCards() {
  var box = el('cardsBody');
  var q = orderedQueue();
  syncDayTotal(q.length);

  if (!q.length) {
    if (doneSound_date !== TODAY && dayTotal > 0) { doneSound_date = TODAY; Sound.done(); }
    box.innerHTML =
      '<div class="gap-xl center stack">' +
        '<div class="h1">На сегодня всё</div>' +
        '<p class="sub">Очередь пуста. Возвращайся завтра.</p>' +
      '</div>';
    return;
  }

  var counts = buildQueue(S, TODAY);
  var id = q[0];
  var card = cardAt(S, id);
  if (!card) return;
  var passed = Math.max(0, dayTotal - q.length);
  var pct = dayTotal ? Math.round(passed / dayTotal * 100) : 0;

  var grades = [
    { g: 0, cls: 'grade--again', label: 'Снова' },
    { g: 1, cls: '', label: 'Трудно' },
    { g: 2, cls: 'grade--good', label: 'Хорошо' },
    { g: 3, cls: '', label: 'Легко' }
  ].map(function (b) {
    return '<button class="grade ' + b.cls + '" data-act="grade" data-g="' + b.g + '">' +
      b.label + '</button>';
  }).join('');

  box.innerHTML =
    '<div class="queue">' +
      '<div class="queue__bar"><div class="queue__fill" style="width:' + pct + '%"></div></div>' +
      '<div class="queue__meta">' +
        '<span>осталось ' + q.length + '</span>' +
        '<span>' + counts.news.length + ' новых · ' + counts.reviews.length + ' повторов</span>' +
      '</div>' +
    '</div>' +

    '<div class="flash" data-act="flip">' +
      weekIcon(card.week) +
      '<div class="flash__en">' + esc(card.en) + '</div>' +
      (flipped
        ? '<div class="flash__ru">' + esc(card.ru) + '</div>'
        : '<div class="flash__hint">нажми, чтобы увидеть перевод</div>') +
    '</div>' +

    (flipped ? '<div class="grades">' + grades + '</div>' : '');
}

function answerCard(grade) {
  var q = orderedQueue();
  if (!q.length) return;
  var id = q[0];
  registerAnswer(S, id, grade, TODAY);
  deferred = deferred.filter(function (x) { return x !== id; });
  if (grade === 0) { deferred.push(id); Sound.again(); }
  else { Sound.good(); }
  flipped = false;
  Store.save(S);
  renderCards();
}

/* ---------------------------------------------------------------- УТРО */

function renderMorning(box, embedded) {
  var t = morningTarget();
  var have = S.mrn[t];

  if (have) {
    box.innerHTML =
      '<div class="gap-xl center stack">' +
        '<div class="h1">Спасибо</div>' +
        '<p class="sub">Ответ за ночь ' + esc(humanDate(t)) + ' записан:<br>' +
          'засыпание ' + have[0] + ' из 5 · лёг ' + esc(BED_LABEL[have[1]]) + '</p>' +
      '</div>' +
      (embedded ? '<button class="btn btn--ghost gap-lg" data-act="to-evening">К вечеру</button>' : '');
    return;
  }

  if (S.fin[t] == null) {
    box.innerHTML =
      '<div class="gap-xl center stack">' +
        '<div class="h1">Пока нечего спрашивать</div>' +
        '<p class="sub">Вопрос про сон появится утром после закрытого вечера.</p>' +
      '</div>';
    return;
  }

  var speedBtns = [1, 2, 3, 4, 5].map(function (v) {
    return '<button class="choice' + (pendingMorning.speed === v ? ' is-picked' : '') +
      '" data-act="mrn-speed" data-v="' + v + '">' + v + '</button>';
  }).join('');

  var bedBtns = BED_LABEL.map(function (lbl, i) {
    return '<button class="choice' + (pendingMorning.bed === i ? ' is-picked' : '') +
      '" data-act="mrn-bed" data-v="' + i + '">' + esc(lbl) + '</button>';
  }).join('');

  box.innerHTML =
    '<div class="h1" style="font-size:27px">Утро</div>' +
    '<p class="sub">Про ночь ' + esc(humanDate(t)) + '</p>' +

    '<div class="panel gap-lg">' +
      '<p class="h2">Как быстро заснул?</p>' +
      '<div class="choices">' + speedBtns + '</div>' +
      '<div class="choices__legend"><span>больше часа</span><span>меньше 15 минут</span></div>' +
    '</div>' +

    '<div class="panel">' +
      '<p class="h2">Во сколько лёг?</p>' +
      '<div class="choices choices--wide">' + bedBtns + '</div>' +
    '</div>';
}

function commitMorningIfReady() {
  if (pendingMorning.speed == null || pendingMorning.bed == null) return false;
  var t = morningTarget();
  if (S.mrn[t]) return false;
  S.mrn[t] = [pendingMorning.speed, pendingMorning.bed];
  pendingMorning = { speed: null, bed: null };
  Sound.done();
  Store.save(S, true);
  return true;
}

/* ------------------------------------------------------------ ПРОГРЕСС */

function fmtAvg(a) { return a.n ? (Math.round(a.avg * 10) / 10).toFixed(1) : '—'; }
function fmtBed(a) { return a.n ? minutesToClock(a.avg) : '—'; }

function sleepChart(series) {
  var W = 320, H = 118, L = 8, R = 8, T = 12, B = 22;
  var n = series.length;
  var iw = W - L - R, ih = H - T - B;
  var x = function (i) { return L + (n === 1 ? iw / 2 : i * iw / (n - 1)); };
  var y = function (v) { return T + ih - (v - 1) / 4 * ih; };

  var grid = [1, 3, 5].map(function (v) {
    return '<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) +
      '" y2="' + y(v).toFixed(1) + '" stroke="#3a322d" stroke-width="1" ' +
      (v === 3 ? 'stroke-dasharray="2 4"' : '') + ' opacity=".7"/>';
  }).join('');

  var segs = [], cur = [];
  series.forEach(function (p, i) {
    if (p.speed == null) { if (cur.length > 1) segs.push(cur); cur = []; }
    else cur.push(x(i).toFixed(1) + ',' + y(p.speed).toFixed(1));
  });
  if (cur.length > 1) segs.push(cur);

  var lines = segs.map(function (s) {
    return '<polyline points="' + s.join(' ') + '" fill="none" stroke="#e0a05a" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }).join('');

  var dots = series.map(function (p, i) {
    if (p.speed == null) return '';
    return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.speed).toFixed(1) +
      '" r="2.6" fill="#e0a05a"/>';
  }).join('');

  var any = series.some(function (p) { return p.speed != null; });
  if (!any) {
    return '<p class="tiny faint center" style="padding:26px 0">Пока нет ответов про сон</p>';
  }

  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="Скорость засыпания за 30 дней">' + grid + lines + dots +
    '<text x="' + L + '" y="' + (H - 6) + '" fill="#7b7168" font-size="10">30 дней назад</text>' +
    '<text x="' + (W - R) + '" y="' + (H - 6) + '" fill="#7b7168" font-size="10" ' +
    'text-anchor="end">сегодня</text></svg>';
}

function renderProgress() {
  var st = computeStats(S, TODAY);
  el('progressBody').innerHTML =
    '<div class="grid2 gap-lg">' +
      '<div class="stat"><div class="stat__v">' + st.done7 + ' / 7</div>' +
        '<div class="stat__k">вечеров за 7 дней</div></div>' +
      '<div class="stat"><div class="stat__v">' + st.done30 + ' / 30</div>' +
        '<div class="stat__k">вечеров за 30 дней</div></div>' +
      '<div class="stat"><div class="stat__v">' + st.streak + '</div>' +
        '<div class="stat__k">' + plural(st.streak, 'день подряд', 'дня подряд', 'дней подряд') +
        '</div></div>' +
      '<div class="stat"><div class="stat__v">' + st.learned + '</div>' +
        '<div class="stat__k">карточек выучено</div></div>' +
    '</div>' +

    '<div class="panel gap-lg">' +
      '<div class="row"><div><div class="row__k">Карточек в работе</div>' +
        '<div class="row__sub">из ' + cardCount(S) + ' в колоде</div></div>' +
        '<div class="stat__v" style="font-size:22px">' + st.inWork + '</div></div>' +
      '<div class="row"><div><div class="row__k">Засыпание</div>' +
        '<div class="row__sub">среднее из 5, за 7 и 30 дней</div></div>' +
        '<div class="stat__v" style="font-size:22px">' + fmtAvg(st.speed7) +
        ' <span class="faint" style="font-size:15px">/ ' + fmtAvg(st.speed30) + '</span></div></div>' +
      '<div class="row"><div><div class="row__k">Средний отбой</div>' +
        '<div class="row__sub">за 7 и 30 дней</div></div>' +
        '<div class="stat__v" style="font-size:22px">' + fmtBed(st.bed7) +
        ' <span class="faint" style="font-size:15px">/ ' + fmtBed(st.bed30) + '</span></div></div>' +
    '</div>' +

    '<div class="panel">' +
      '<p class="tiny faint" style="margin:0 0 4px">ЗАСЫПАНИЕ ЗА 30 ДНЕЙ</p>' +
      sleepChart(st.series) +
    '</div>';
}

/* ----------------------------------------------------------- НАСТРОЙКИ */

function utf8len(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3);
  }
  return n;
}

function exportSummary() {
  var st = computeStats(S, TODAY);
  return {
    day: S.day, done7: st.done7, done30: st.done30, streak: st.streak,
    learned: st.learned, inWork: st.inWork,
    speed7: st.speed7.n ? Math.round(st.speed7.avg * 10) / 10 : null,
    bed7: st.bed7.n ? minutesToClock(st.bed7.avg) : null,
    date: dateISO(TODAY)
  };
}

function buildExport() {
  return JSON.stringify({
    app: 'english-evenings', v: STATE_V,
    exported: new Date().toISOString(),
    summary: exportSummary(),
    payload: encodeState(S)
  });
}

function openSheet() {
  el('sheetBody').innerHTML =
    '<div class="row" data-act="toggle-sound" role="switch" aria-checked="' +
      (S.sound ? 'true' : 'false') + '">' +
      '<div><div class="row__k">Звуки</div>' +
      '<div class="row__sub">короткие тихие сигналы</div></div>' +
      '<span class="toggle' + (S.sound ? ' is-on' : '') + '" aria-hidden="true"></span>' +
    '</div>' +

    '<div class="row">' +
      '<div><div class="row__k">Текущий день</div>' +
      '<div class="row__sub">1–' + TOTAL_DAYS + ', сдвигается сам после Finish</div></div>' +
      '<input class="numfield" id="dayField" type="number" inputmode="numeric" ' +
        'min="1" max="' + TOTAL_DAYS + '" value="' + S.day + '">' +
    '</div>' +
    '<button class="btn btn--sm btn--ghost" data-act="save-day" style="margin-top:4px">' +
      'Сохранить день</button>' +
    '<div id="dayNote"></div>' +

    '<div style="margin-top:22px">' +
      '<div class="row__k">Экспорт состояния</div>' +
      '<div class="row__sub">полная копия: карточки, дни, ответы про сон</div>' +
      '<button class="btn btn--sm btn--ghost" data-act="export" style="margin-top:10px">' +
        'Экспортировать</button>' +
      '<div id="exportBox"></div>' +
    '</div>' +

    '<div style="margin-top:22px">' +
      '<div class="row__k">Импорт состояния</div>' +
      '<div class="row__sub">вставь JSON из экспорта — состояние заменится</div>' +
      '<textarea class="ta" id="importArea" placeholder=\'{"app":"english-evenings",...}\'></textarea>' +
      '<button class="btn btn--sm btn--ghost" data-act="import" style="margin-top:8px">' +
        'Импортировать</button>' +
      '<div id="importNote"></div>' +
    '</div>';
  el('sheet').hidden = false;
}

function closeSheet() { el('sheet').hidden = true; }

function doExport() {
  var json = buildExport();
  var box = el('exportBox');
  var lines = [];

  var sent = false;
  if (tg && tg.sendData) {
    try {
      if (utf8len(json) <= 4096) { tg.sendData(json); sent = true; }
      else {
        var small = JSON.stringify({
          app: 'english-evenings', v: STATE_V,
          exported: new Date().toISOString(),
          summary: exportSummary(), partial: true
        });
        if (utf8len(small) <= 4096) { tg.sendData(small); }
        lines.push('<p class="note">Копия целиком не помещается в сообщение Telegram — ' +
          'в чат ушла только сводка. Полная копия ниже.</p>');
      }
    } catch (e) {
      lines.push('<p class="note">Отправить в чат не получилось — приложение открыто ' +
        'не с кнопки клавиатуры. Полная копия ниже.</p>');
    }
  }

  copyText(json, function (ok) {
    box.innerHTML =
      (sent ? '<p class="note note--ok">Отправлено в чат.</p>' : '') +
      lines.join('') +
      '<p class="note' + (ok ? ' note--ok' : ' note--warn') + '">' +
        (ok ? 'Скопировано в буфер обмена.' : 'Буфер недоступен — выдели текст и скопируй:') +
      '</p>' +
      '<textarea class="ta" id="exportArea" readonly></textarea>';
    var area = el('exportArea');
    area.value = json;
    if (!ok) { area.focus(); area.setSelectionRange(0, json.length); }
  });
  Sound.good();
}

function doImport() {
  var note = el('importNote');
  var raw = (el('importArea').value || '').trim();
  if (!raw) { note.innerHTML = '<p class="note note--warn">Пусто — вставь JSON.</p>'; return; }

  var payload = null;
  try {
    var obj = JSON.parse(raw);
    if (obj && typeof obj.payload === 'string') payload = obj.payload;
    else throw new Error('в JSON нет поля payload');
  } catch (e) {
    if (raw.indexOf('\n') > 0 && /^\d+\n/.test(raw)) payload = raw;   /* «голая» строка состояния */
    else {
      note.innerHTML = '<p class="note note--warn">Не похоже на экспорт: ' +
        esc(e.message) + '</p>';
      Sound.again();
      return;
    }
  }

  var next;
  try { next = decodeState(payload); }
  catch (e2) {
    note.innerHTML = '<p class="note note--warn">Состояние повреждено: ' + esc(e2.message) +
      '</p><p class="note">Текущее состояние не тронуто.</p>';
    Sound.again();
    return;
  }

  S = next;
  Sound.setOn(S.sound);
  deferred = []; flipped = false; dayTotal_date = 0; curtainDismissed = false;
  Store.save(S, true, function (err) {
    note.innerHTML = err
      ? '<p class="note note--warn">Прочитано, но не сохранилось: ' + esc(String(err.message || err)) + '</p>'
      : '<p class="note note--ok">Состояние восстановлено. День ' + S.day + '.</p>';
  });
  Sound.done();
  render();
}

function saveDay() {
  var v = parseInt(el('dayField').value, 10);
  var note = el('dayNote');
  if (!isFinite(v) || v < 1 || v > TOTAL_DAYS) {
    note.innerHTML = '<p class="note note--warn">Нужно число от 1 до ' + TOTAL_DAYS + '.</p>';
    Sound.again();
    return;
  }
  S.day = v;
  Store.save(S, true);
  note.innerHTML = '<p class="note note--ok">Текущий день — ' + v + '.</p>';
  Sound.good();
  render();
}

/* ----------------------------------------------------------- ЗАПУСК */

function dismissCurtain() {
  if (Date.now() - curtainAt < 2500) return;   /* дать занавесу догореть */
  curtainDismissed = true;
  curtain(false);
  render();
}

function checkRollover() {
  var t = logicalDate(new Date());
  if (t === TODAY) return;
  TODAY = t;
  curtainDismissed = false;
  deferred = []; flipped = false; dayTotal_date = 0;
  pendingMorning = { speed: null, bed: null };
  if (stageTimer) { clearTimeout(stageTimer); stageTimer = null; }
  if (!el('curtain').hidden) curtain(false);
  render();
}

function onAction(e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (!t) return;
  var a = t.getAttribute('data-act');
  Sound.unlock();

  if (a === 'open-cards') { Sound.tap(); go('cards'); }
  else if (a === 'conv-start') startStage(1);
  else if (a === 'conv-next') startStage(currentStage() + 1);
  else if (a === 'copy-stage') onCopyStage();
  else if (a === 'save-review') onSaveReview();
  else if (a === 'copy-anchor') {
    copyText(ANCHOR_PROMPT, function (ok) {
      if (ok) { Sound.good(); return; }
      Sound.again();
      var box = el('copyBox');
      if (!box) return;
      box.innerHTML = '<p class="note note--warn">Буфер недоступен, скопируй вручную:</p>' +
        '<textarea class="ta" id="copyArea" spellcheck="false"></textarea>';
      var ar = el('copyArea');
      ar.value = ANCHOR_PROMPT;
      ar.focus(); ar.setSelectionRange(0, ANCHOR_PROMPT.length);
    });
  }
  else if (a === 'finish') doFinish();
  else if (a === 'flip') { if (!flipped) { flipped = true; Sound.flip(); renderCards(); } }
  else if (a === 'grade') answerCard(parseInt(t.getAttribute('data-g'), 10));
  else if (a === 'mrn-speed' || a === 'mrn-bed') {
    var v = parseInt(t.getAttribute('data-v'), 10);
    if (a === 'mrn-speed') pendingMorning.speed = v; else pendingMorning.bed = v;
    Sound.tap();    var embedded = (tab === 'today');
    var box = embedded ? el('todayBody') : el('morningBody');
    if (commitMorningIfReady()) {
      renderMorning(box, embedded);
      setTimeout(function () { render(); }, 1400);
    } else {
      renderMorning(box, embedded);
    }
  }
  else if (a === 'to-evening') render();
  else if (a === 'toggle-sound') {
    S.sound = !S.sound;
    Sound.setOn(S.sound);
    Store.save(S, true);
    if (S.sound) Sound.good();
    openSheet();
  }
  else if (a === 'save-day') saveDay();
  else if (a === 'export') doExport();
  else if (a === 'import') doImport();
}

function wire() {
  var doc = global.document;

  el('tabbar').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (!b) return;
    Sound.unlock(); Sound.tap();    go(b.getAttribute('data-go'));
  });

  el('btnSettings').addEventListener('click', function () { Sound.unlock(); openSheet(); });
  el('curtain').addEventListener('click', dismissCurtain);
  el('sheet').addEventListener('click', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) closeSheet();
  });

  doc.addEventListener('click', onAction);
  doc.addEventListener('visibilitychange', checkRollover);
  setInterval(checkRollover, 30000);
}

/* Бот может открыть приложение на конкретном дне: ?day=N в адресе кнопки
   или start_param=dN у прямой ссылки Mini App. */
function requestedDay() {
  try {
    var sp = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;
    var m = sp && /^d(\d{1,3})$/.exec(String(sp));
    if (m) return parseInt(m[1], 10);
    var loc = global.location;
    if (loc) {
      var q = /[?&]day=(\d{1,3})\b/.exec(String(loc.search || '') + '&' + String(loc.hash || ''));
      if (q) return parseInt(q[1], 10);
    }
  } catch (e) {}
  return 0;
}

function applyStartParam() {
  var n = requestedDay();
  if (n >= 1 && n <= TOTAL_DAYS && n !== S.day) { S.day = n; Store.save(S, true); }
}

function fatal(msg) {
  var f = el('fatal');
  if (!f) return;
  f.hidden = false;
  f.textContent = msg;
  el('app').hidden = true;
}

function init() {
  try {
    tg = (global.Telegram && global.Telegram.WebApp) ? global.Telegram.WebApp : null;
    if (tg) {
      tg.ready();
      var atLeast = function (v) {
        try { return !tg.isVersionAtLeast || tg.isVersionAtLeast(v); } catch (e) { return false; }
      };
      try { tg.expand(); } catch (e) {}
      if (atLeast('6.1')) {
        try { tg.setHeaderColor('#141110'); tg.setBackgroundColor('#141110'); } catch (e) {}
      }
      if (atLeast('7.7') && tg.disableVerticalSwipes) {
        try { tg.disableVerticalSwipes(); } catch (e) {}
      }
    }
    Store.attach(tg);

    if (DAYS.length !== TOTAL_DAYS || !CARDS.length) {
      return fatal('data.js не загрузился или собран неверно: дней ' + DAYS.length +
        ', карточек ' + CARDS.length + '. Запусти build.py заново.');
    }

    TODAY = logicalDate(new Date());

    Store.load(function (err, state, how) {
      S = state;
      Sound.setOn(S.sound);
      applyStartParam();
      el('app').hidden = false;
      wire();
      armStageTimer();          /* этап мог идти, пока приложение было закрыто */
      go('today');
      if (how === 'corrupt' || how === 'error') {
        setTimeout(function () {
          var box = el('todayBody');
          if (box) box.insertAdjacentHTML('afterbegin',
            '<p class="note note--warn">Сохранённое состояние не прочиталось, ' +
            'начали с чистого. Если есть копия — восстанови её через Настройки → Импорт.</p>');
        }, 0);
      }
    });
  } catch (e) {
    fatal('Ошибка запуска: ' + (e && e.message ? e.message : String(e)));
  }
}

/* ------------------------------------------------- экспорт для тестов */

var API = {
  DAY_MS: DAY_MS, CUTOFF_H: CUTOFF_H, NEW_PER_DAY: NEW_PER_DAY,
  LEARNED_IVL: LEARNED_IVL, TOTAL_DAYS: TOTAL_DAYS, STATE_V: STATE_V,
  BED_MIN: BED_MIN, BED_LABEL: BED_LABEL,
  dateNumOf: dateNumOf, logicalDate: logicalDate, dateParts: dateParts, dateISO: dateISO,
  minutesToClock: minutesToClock, plural: plural,

  freshCard: freshCard, sm2: sm2,
  newAllowance: newAllowance, pickNew: pickNew, buildQueue: buildQueue,
  parseReview: parseReview, saveReview: saveReview, recentMistakes: recentMistakes,
  withMistakes: withMistakes, cardCount: cardCount, cardAt: cardAt,
  reviewKey: reviewKey, REVIEW_MAX: REVIEW_MAX, REVIEW_DAYS: REVIEW_DAYS,
  registerAnswer: registerAnswer, computeStats: computeStats,
  blankState: blankState, encodeState: encodeState, decodeState: decodeState,
  checksum: checksum, utf8len: utf8len
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (global.document) {
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : this));

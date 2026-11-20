// dsh-auto-send — composer-side scheduled send.
//
// One slot occupant:
//   conversation.input.right  -> the clock button (the armed capsule) and the
//                                small setting popover that hangs above it
//
// The popover is rendered from inside the button slot and positioned `fixed`
// from the button's measured corner, so it never takes over the composer width.
//
// All actual delivery is done by the Host `dsh-schedule` service through the
// client remote; this file holds no timer that matters across a page reload.

window.__ModuleLoader__.load({
  id: 'dsh-auto-send',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TITLE_PREFIX = '定时发送 · ';
    // The point of this feature is to spend AI tokens off the peak-priced hours,
    // so the shortcuts are the two off-peak send times, both on today's date.
    const PRESET_TIMES = ['12:00', '18:00'];

    // Accents are opt-in: "auto" inherits whatever the DSH theme uses, the other
    // two pin a color that reads on both the light and the dark surface.
    const THEME_KEY = 'dsh-auto-send.theme.v1';
    const THEMES = [
      { id: 'auto', label: '跟随主题', dot: null, accent: null, ink: null },
      { id: 'orange', label: '暖橙', dot: '#ff7a18', accent: '#ff7a18', ink: '#2a1505' },
      { id: 'blue', label: 'DeepSeek 蓝', dot: '#4d6bfe', accent: '#4d6bfe', ink: '#ffffff' },
    ];

    let HOST = null;

    // ---------------------------------------------------------------- store

    const store = new Map();
    const listeners = new Set();

    function blankState() {
      return {
        task: null,
        loaded: false,
        loading: false,
        panelOpen: false,
        // Hover opens a preview that closes again on mouse-out; a click pins it.
        pinned: false,
        day: 0,
        timeText: '',
        custom: false,
        busy: false,
        error: '',
        syncedPrompt: null,
      };
    }

    function slotOf(sessionId) {
      let s = store.get(sessionId);
      if (!s) {
        s = blankState();
        store.set(sessionId, s);
      }
      return s;
    }

    function notify() {
      for (const listener of Array.from(listeners)) {
        try { listener(); } catch (_) { /* a dead subscriber must not break the rest */ }
      }
    }

    function patch(sessionId, next) {
      if (!sessionId) return;
      Object.assign(slotOf(sessionId), next);
      notify();
    }

    function useSlot(sessionId) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }, []);
      return sessionId ? slotOf(sessionId) : blankState();
    }

    // ---------------------------------------------------------------- accent

    function readTheme() {
      try {
        const saved = window.localStorage.getItem(THEME_KEY);
        if (saved && THEMES.some(function (item) { return item.id === saved; })) return saved;
      } catch (_) { /* private mode, storage disabled — fall back to auto */ }
      return 'auto';
    }

    let themeId = readTheme();

    function themeOf() {
      for (const item of THEMES) if (item.id === themeId) return item;
      return THEMES[0];
    }

    function setTheme(id) {
      if (!THEMES.some(function (item) { return item.id === id; })) return;
      themeId = id;
      try { window.localStorage.setItem(THEME_KEY, id); } catch (_) { /* ignore quota / privacy errors */ }
      notify();
    }

    /**
     * The card paints itself with `--as-accent`. Leaving those unset makes every
     * accent fall through to the DSH theme token, so light and dark both work
     * without this plugin knowing which one is on.
     */
    function accentVars() {
      const theme = themeOf();
      if (!theme.accent) return null;
      return { '--as-accent': theme.accent, '--as-accent-ink': theme.ink };
    }

    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, [active]);
      return now;
    }

    // ----------------------------------------------------------------- time

    const TIME_ZONE = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch (_) { return 'UTC'; }
    })();

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function timeKey(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    // The Host's local-at selector requires HH:mm:ss (fraction optional); HH:mm is rejected as invalid_rule.
    function timeKeyFull(d) { return timeKey(d) + ':' + pad2(d.getSeconds()); }

    function startOfDay(d) {
      const x = new Date(d.getTime());
      x.setHours(0, 0, 0, 0);
      return x;
    }

    function dayOffset(d) {
      return Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / 86400000);
    }

    function formatWhen(d) {
      if (!d || isNaN(d.getTime())) return '';
      const offset = dayOffset(d);
      const clock = timeKey(d);
      if (offset === 0) return '今天 ' + clock;
      if (offset === 1) return '明天 ' + clock;
      if (offset === 2) return '后天 ' + clock;
      if (offset === -1) return '昨天 ' + clock;
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + clock;
    }

    function formatDelta(ms) {
      if (ms <= 0) return '正在发送';
      const total = Math.floor(ms / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (days > 0) return days + ' 天 ' + hours + ' 小时';
      if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
      if (minutes > 0) return minutes + ' 分 ' + seconds + ' 秒';
      return seconds + ' 秒';
    }

    function parseWallClock(date, time) {
      if (!date || !time) return null;
      const when = new Date(date + 'T' + time + ':00');
      return isNaN(when.getTime()) ? null : when;
    }

    // ------------------------------------------------------------- host api

    function scheduleApi() {
      const remote = HOST && HOST.remote;
      const schedule = remote && remote.schedule;
      if (!schedule) throw new Error('调度服务还没连上');
      return schedule;
    }

    function describeError(error) {
      const details = error && error.details;
      const byDetail = {
        not_future: '这个时间已经过去了',
        invalid_rule: '时间规则无效',
        invalid_selector: '时间规则无效',
        frequency_too_high: '发送太频繁了',
        invalid_time_zone: '时区无效',
        time_out_of_range: '时间超出范围',
        invalid_prompt: '要发送的内容是空的',
        subagent_session: '子会话不能接收定时消息',
      };
      if (details && byDetail[details.code]) return byDetail[details.code];
      const code = (error && error.code) || '';
      if (code === 'schedule/input-invalid') return '时间设置无效';
      if (code === 'schedule/target-archived') return '这个会话已归档，收不到定时消息';
      if (code === 'schedule/conflict') return '任务已被改动，刷新后再试';
      return '没有成功（' + (code || '未知错误') + '）';
    }

    function unwrap(result) {
      if (!result || typeof result !== 'object') throw new Error('调度服务没有返回结果');
      if (result.ok === false) throw new Error(describeError(result.error));
      return result.value;
    }

    function normalize(item) {
      if (!item || !item.id) return null;
      const at = item.scheduledAt ? new Date(item.scheduledAt) : null;
      return {
        id: item.id,
        title: item.title || '',
        prompt: item.prompt || '',
        at: at && !isNaN(at.getTime()) ? at : null,
        status: item.status || 'active',
        updatedAt: item.updatedAt || '',
      };
    }

    function pickTask(list, sessionId) {
      const items = (list && list.items) || [];
      for (const item of items) {
        if (!item || typeof item.title !== 'string') continue;
        if (item.title.indexOf(TITLE_PREFIX) !== 0) continue;
        const target = item.target;
        if (!target || target.kind !== 'session' || target.sessionId !== sessionId) continue;
        return normalize(item);
      }
      return null;
    }

    function refresh(sessionId, options) {
      if (!sessionId) return;
      const s = slotOf(sessionId);
      if (s.loading) return;
      patch(sessionId, { loading: true });
      let request;
      try { request = scheduleApi().list({ active: true }); }
      catch (_) {
        patch(sessionId, { loading: false, loaded: true });
        return;
      }
      Promise.resolve(request).then(unwrap).then((list) => {
        patch(sessionId, { loading: false, loaded: true, task: pickTask(list, sessionId) });
      }).catch(() => {
        patch(sessionId, { loading: false, loaded: true });
      });
    }

    function refreshAll() {
      for (const sessionId of Array.from(store.keys())) {
        const s = store.get(sessionId);
        if (s && s.loaded) refresh(sessionId);
      }
    }

    // ------------------------------------------------------------ compose

    /** The card only offers three days: today, tomorrow, the day after. */
    const DAY_OPTIONS = [0, 1, 2];

    function dayLabel(offset) {
      if (offset === 0) return '今天';
      if (offset === 1) return '明天';
      return '后天';
    }

    function dayDate(offset) {
      const day = new Date();
      day.setDate(day.getDate() + offset);
      return day;
    }

    /**
     * Hand-typed clock. "12:30", "1230", "930" and "9" all mean the obvious
     * thing; anything else is rejected so the panel never sends at a guess.
     */
    function parseTimeText(text) {
      const raw = String(text == null ? '' : text).trim().replace(/[：.．]/g, ':').replace(/\s+/g, '');
      if (!raw) return null;
      let hour;
      let minute;
      if (raw.indexOf(':') >= 0) {
        const parts = raw.split(':');
        if (parts.length !== 2) return null;
        if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) return null;
        hour = Number(parts[0]);
        minute = Number(parts[1]);
      } else {
        if (!/^\d{1,4}$/.test(raw)) return null;
        if (raw.length <= 2) { hour = Number(raw); minute = 0; }
        else if (raw.length === 3) { hour = Number(raw.slice(0, 1)); minute = Number(raw.slice(1)); }
        else { hour = Number(raw.slice(0, 2)); minute = Number(raw.slice(2)); }
      }
      if (!(hour >= 0 && hour <= 23)) return null;
      if (!(minute >= 0 && minute <= 59)) return null;
      return pad2(hour) + ':' + pad2(minute);
    }

    /** Ten minutes out: the clock the panel opens with. */
    function tenMinutesOut() {
      const soon = new Date(Date.now() + 10 * 60000);
      return { day: Math.max(0, dayOffset(soon)), timeText: timeKey(soon) };
    }

    /**
     * The two off-peak shortcuts. This feature exists to move work out of the
     * expensive hours, so the buttons are the two cheap windows (12:00 and
     * 18:00): today when that window is still ahead, tomorrow once it passed.
     */
    function presetSlots() {
      const now = Date.now();
      return PRESET_TIMES.map(function (time) {
        const today = parseWallClock(dateKey(dayDate(0)), time);
        const offset = today && today.getTime() > now ? 0 : 1;
        return { day: offset, time: time, label: dayLabel(offset) + ' ' + time };
      });
    }

    function ensureDefaults(sessionId) {
      const s = slotOf(sessionId);
      if (typeof s.day !== 'number' || !s.timeText) patch(sessionId, tenMinutesOut());
    }

    /**
     * The wall clock the form points at. A clock that already passed today rolls
     * to the same time tomorrow instead of failing (FR-7); `writeBack` pushes
     * that roll into the form so the user sees what will actually happen.
     */
    function plannedAt(sessionId, writeBack) {
      const s = slotOf(sessionId);
      const clock = parseTimeText(s.timeText);
      if (!clock) return null;
      const offset = typeof s.day === 'number' ? s.day : 0;
      const wall = parseWallClock(dateKey(dayDate(offset)), clock);
      if (!wall) return null;
      if (wall.getTime() > Date.now()) return wall;
      const next = new Date(wall.getTime() + 86400000);
      if (writeBack) patch(sessionId, { day: offset + 1, timeText: clock });
      return next;
    }

    /** True when the typed clock already went by today, so it will roll over. */
    function rollsOver(sessionId) {
      const s = slotOf(sessionId);
      if (s.day !== 0) return false;
      const clock = parseTimeText(s.timeText);
      const wall = clock ? parseWallClock(dateKey(dayDate(0)), clock) : null;
      return !!wall && wall.getTime() <= Date.now();
    }

    /** One concrete wall clock, expressed as a Host timing plus its phrase. */
    function timingOf(wall) {
      return {
        label: formatWhen(wall),
        timing: {
          kind: 'at',
          at: { date: dateKey(wall), time: timeKeyFull(wall), time_zone: TIME_ZONE },
        },
      };
    }

    /** The wall clock a one-click shortcut resolves to. */
    function slotWall(slot) {
      return parseWallClock(dateKey(dayDate(slot.day)), slot.time);
    }

    /**
     * Create (or reschedule) the session's single scheduled send. `wall` lets a
     * one-click shortcut bypass the form entirely.
     */
    function submit(sessionId, draft, wall) {
      const s = slotOf(sessionId);
      if (s.busy) return;
      const text = String(draft == null ? '' : draft).trim();
      if (!text) {
        patch(sessionId, { error: '输入框是空的，先写要发送的内容' });
        return;
      }
      const target = wall || plannedAt(sessionId, true);
      if (!target) {
        patch(sessionId, { error: '时间看不懂，写成 12:30 或 1230、930 都行' });
        return;
      }
      const plan = timingOf(target);
      const title = (TITLE_PREFIX + plan.label).slice(0, 120);
      const existing = s.task;
      patch(sessionId, { busy: true, error: '' });

      let call;
      try {
        if (existing) {
          call = scheduleApi().edit({
            id: existing.id,
            action: 'update',
            patch: { title: title, prompt: text, timing: plan.timing },
          });
        } else {
          call = scheduleApi().create({
            title: title,
            prompt: text,
            timing: plan.timing,
            target: { kind: 'session', sessionId: sessionId },
          });
        }
      } catch (error) {
        patch(sessionId, { busy: false, error: error.message });
        return;
      }

      Promise.resolve(call).then(unwrap).then((value) => {
        const task = normalize(value) || null;
        patch(sessionId, { busy: false, panelOpen: false, pinned: false, error: '', task: task, syncedPrompt: null });
        // The edit result may be a delete-shaped union member; trust the Host list then.
        refresh(sessionId);
      }).catch((error) => {
        patch(sessionId, { busy: false, error: error.message });
      });
    }

    /**
     * The Host sends its own stored copy of the text, not the composer's current
     * contents. Keeping that copy equal to the draft after arming means a later
     * edit in the input box needs no second press on the clock.
     */
    function syncPrompt(sessionId, text) {
      const s = slotOf(sessionId);
      const task = s.task;
      if (!task || s.busy || !text) return;
      if (task.prompt === text || s.syncedPrompt === text) return;
      patch(sessionId, { syncedPrompt: text });
      let call;
      try {
        call = scheduleApi().edit({ id: task.id, action: 'update', patch: { prompt: text } });
      } catch (_) {
        return;
      }
      Promise.resolve(call).then(unwrap).then(function (value) {
        const next = normalize(value);
        if (next) patch(sessionId, { task: next });
      }).catch(function () {
        // Keep the mark so a Host that keeps refusing is not retried on every keystroke.
        patch(sessionId, { syncedPrompt: text });
      });
    }


    function cancelTask(sessionId) {
      const s = slotOf(sessionId);
      if (s.busy || !s.task) return;
      const id = s.task.id;
      patch(sessionId, { busy: true, error: '' });
      let call;
      try { call = scheduleApi().edit({ id: id, action: 'delete' }); }
      catch (error) { patch(sessionId, { busy: false, error: error.message }); return; }
      Promise.resolve(call).then(unwrap).then(() => {
        patch(sessionId, { busy: false, task: null, syncedPrompt: null });
      }).catch((error) => {
        patch(sessionId, { busy: false, error: error.message });
      });
    }

    // Hover preview: opens on mouse-enter, closes again on mouse-out.
    function openPanel(sessionId) {
      if (!sessionId) return;
      ensureDefaults(sessionId);
      patch(sessionId, { panelOpen: true, pinned: false, custom: false, error: '' });
      if (!slotOf(sessionId).loaded) refresh(sessionId);
    }

    // Click pins the card: it stays up after the pointer leaves, and the next
    // click on the clock puts it away.
    function pinPanel(sessionId) {
      if (!sessionId) return;
      ensureDefaults(sessionId);
      if (slotOf(sessionId).panelOpen && slotOf(sessionId).pinned) {
        closePanel(sessionId);
        return;
      }
      patch(sessionId, { panelOpen: true, pinned: true, error: '' });
      if (!slotOf(sessionId).loaded) refresh(sessionId);
    }

    function closePanel(sessionId) {
      patch(sessionId, { panelOpen: false, pinned: false, error: '' });
    }


    // -------------------------------------------------------------- styles

    // Theme tokens only: this file ships once and has to look native in both the
    // light and the dark theme, and in every future palette.
    const MUTED = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))';
    const CAPTION = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.72))';
    const HAIRLINE = '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))';
    const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))';
    const ACTIVE = 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16))';
    const SURFACE = 'var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, transparent))';
    const SHADOW = 'var(--dsw-elevation-soft, 0 6px 20px rgba(0,0,0,0.10))';

    const ST = {
      iconButton: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '28px', height: '28px', padding: '0', border: 'none', borderRadius: '8px',
        background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: '0.55',
        transition: 'opacity 120ms ease, background 120ms ease',
      },
      iconButtonOff: { opacity: '0.28', cursor: 'not-allowed' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px',
        padding: '0 8px', border: HAIRLINE, borderRadius: '999px',
        background: HOVER, color: 'inherit', cursor: 'pointer',
        font: 'inherit', fontSize: '12px', whiteSpace: 'nowrap',
      },
      pillText: { fontVariantNumeric: 'tabular-nums' },
      pillClose: {
        border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
        padding: '0 2px', fontSize: '13px', lineHeight: '1', opacity: '0.6',
      },
      // A compact popover hanging just above the clock button: this is one small
      // setting, so it must not take over the composer's width or push the layout.
      anchor: { display: 'inline-flex', alignItems: 'center', position: 'relative' },
      // The layer is anchored by CSS to the button span (`left: 0`, just above it),
      // so "directly above the clock" comes from the browser's own layout instead
      // of a measured guess. The bridge and the tip live outside the scrolling card
      // so the pointer can travel from the button into the card through that little
      // triangle without the popover closing itself.
      layer: {
        position: 'absolute', left: '0', bottom: 'calc(100% + 8px)',
        zIndex: '60', width: '236px', maxHeight: '55vh',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
      },
      pop: {
        boxSizing: 'border-box', width: '100%', padding: '8px 10px 9px',
        border: HAIRLINE, borderRadius: '12px', background: SURFACE,
        boxShadow: SHADOW, color: 'inherit', font: 'inherit', fontSize: '12px',
        display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto',
        pointerEvents: 'auto',
      },
      // A wide invisible corridor across the gap: the pointer can drift a little
      // left or right on its way up from the clock and still count as "inside".
      popBridge: { position: 'absolute', left: '-48px', right: '-48px', bottom: '-8px', height: '11px' },
      popTip: {
        position: 'absolute', bottom: '-6px', left: '8px', width: '0', height: '0',
        borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
        borderTop: '6px solid ' + SURFACE,
      },
      popHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      popTitle: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', fontWeight: '600',
        color: 'var(--as-accent, currentColor)',
      },
      popRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      dots: { display: 'flex', alignItems: 'center', gap: '4px', padding: '0' },
      dot: {
        width: '9px', height: '9px', padding: '0', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
        background: 'currentColor', opacity: '0.35', cursor: 'pointer',
      },
      dotOn: { opacity: '1', boxShadow: '0 0 0 2px rgba(127,127,127,0.28)' },
      hint: { color: CAPTION, fontSize: '11px', lineHeight: '1.45' },
      close: {
        border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer',
        fontSize: '12px', lineHeight: '1', padding: '2px 4px', borderRadius: '6px',
      },
      quick: {
        display: 'inline-flex', alignItems: 'baseline', gap: '3px',
        padding: '4px 8px', border: '1px solid transparent', borderRadius: '7px',
        background: 'var(--as-accent, var(--dsw-alias-brand-primary, #2b2f36))',
        color: 'var(--as-accent-ink, var(--dsw-alias-label-primary-inverted, #fff))',
        cursor: 'pointer', font: 'inherit',
      },
      quickOff: { opacity: '0.5', cursor: 'progress' },
      quickTime: {
        fontSize: '11px', fontWeight: '600', fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.2px',
      },
      quickDay: { fontSize: '10px', color: 'inherit', opacity: '0.6' },
      link: {
        border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer',
        font: 'inherit', fontSize: '11px', padding: '2px 0',
        textDecoration: 'underline', textUnderlineOffset: '3px',
      },
      customRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      select: {
        boxSizing: 'border-box', border: HAIRLINE, background: 'transparent', color: 'inherit',
        borderRadius: '7px', padding: '4px 4px', font: 'inherit', fontSize: '11px',
        cursor: 'pointer',
      },
      option: { background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'inherit' },
      fieldBad: { borderColor: 'rgba(217,83,79,0.7)' },
      field: {
        boxSizing: 'border-box', border: HAIRLINE, background: 'transparent', color: 'inherit',
        borderRadius: '7px', padding: '3px 6px', font: 'inherit', fontSize: '12px',
        fontVariantNumeric: 'tabular-nums', colorScheme: 'normal', width: '62px',
      },
      primary: {
        border: 'none', borderRadius: '7px', padding: '4px 10px', cursor: 'pointer',
        background: 'var(--as-accent, var(--dsw-alias-brand-primary, #2b2f36))',
        color: 'var(--as-accent-ink, var(--dsw-alias-label-primary-inverted, #fff))',
        font: 'inherit', fontSize: '11px', fontWeight: '600',
        fontVariantNumeric: 'tabular-nums',
      },
      primaryOff: { opacity: '0.45', cursor: 'not-allowed' },
      error: { color: '#d9534f', fontSize: '11px' },
    };


    function Glyph(props) {
      const size = props.size || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' },
      },
        h('circle', { cx: '8', cy: '8', r: '6.2' }),
        h('path', { d: 'M8 4.6V8l2.4 1.6' })
      );
    }

    // ---------------------------------------------------------- components

    function formatCountdown(task, now) {
      if (!task || !task.at) return '';
      const delta = task.at.getTime() - now;
      return delta <= 0 ? '正在发送' : '剩 ' + formatDelta(delta);
    }

    function SendButton(props) {
      const useInput = typeof props.useInput === 'function' ? props.useInput : null;
      const draft = useInput ? useInput(function (state) { return state && state.draft; }) : '';
      const sessionId = props.sessionId || (props.session && props.session.id) || null;
      const s = useSlot(sessionId);
      const now = useNow(Boolean(s.task));
      const ready = typeof draft === 'string' ? draft.trim().length > 0 : true;
      const liveText = typeof draft === 'string' ? draft.trim() : '';
      const anchorRef = React.useRef(null);

      // Hovering the clock opens the card; moving the pointer up to the card
      // crosses the bridge and the tip, which stay inside this span, so the
      // delayed close only fires when the pointer really leaves the group.
      // Clicking pins the card so it stays put until clicked again.
      const hoverTimer = React.useRef(null);
      function cancelHoverClose() {
        if (hoverTimer.current) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
      }
      React.useEffect(function () {
        return function () { cancelHoverClose(); };
      }, []);

      // A reload must still show the armed pill (and feed the text sync below).
      React.useEffect(function () {
        if (sessionId && !s.loaded && !s.loading) refresh(sessionId);
      }, [sessionId, s.loaded, s.loading]);

      // Typing after arming keeps the pending task's text current (debounced), so
      // the user edits once and never presses the clock a second time.
      React.useEffect(function () {
        if (!sessionId || !s.task || !liveText || s.busy) return undefined;
        if (s.task.prompt === liveText || s.syncedPrompt === liveText) return undefined;
        const timer = setTimeout(function () { syncPrompt(sessionId, liveText); }, 700);
        return function () { clearTimeout(timer); };
      }, [sessionId, liveText, s.task, s.syncedPrompt, s.busy]);

      // The card is anchored by CSS to the button's own box (`left: 0`, just above
      // it), so the browser — not a measured guess — decides where "above the
      // clock" is. No JS positioning: the card can never drift away from the icon.
      React.useEffect(function () {
        if (!s.panelOpen) return undefined;
        function onPointerDown(event) {
          const root = anchorRef.current;
          if (root && root.contains && root.contains(event.target)) return;
          closePanel(sessionId);
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') closePanel(sessionId);
        }
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [s.panelOpen, sessionId]);

      if (!sessionId) return null;

      const clock = s.task
        ? h('div', { style: ST.pill, role: 'group', 'aria-label': '定时发送' },
            h('button', {
              type: 'button',
              title: s.task.at ? '已定时 ' + formatWhen(s.task.at) : '已定时',
              'aria-label': '定时发送',
              'aria-expanded': s.panelOpen ? 'true' : 'false',
              onClick: function () { pinPanel(sessionId); },
              style: { display: 'inline-flex', alignItems: 'center', gap: '6px', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0', font: 'inherit', fontSize: '12px' },
            },
              h(Glyph, { size: 14 }),
              h('span', { style: ST.pillText }, (s.task.at ? timeKey(s.task.at) : '定时') + ' · ' + formatCountdown(s.task, now))
            ),
            h('button', {
              type: 'button',
              title: '取消这条定时发送',
              'aria-label': '取消定时发送',
              disabled: s.busy,
              onClick: function (event) { event.stopPropagation(); cancelTask(sessionId); },
              style: ST.pillClose,
            }, '✕')
          )
        : h('button', {
            type: 'button',
            title: ready ? '定时发送这条消息' : '先写要发送的内容',
            'aria-label': '定时发送',
            'aria-expanded': s.panelOpen ? 'true' : 'false',
            onClick: function () { pinPanel(sessionId); },
            onMouseEnter: function (event) { event.currentTarget.style.opacity = '0.95'; event.currentTarget.style.background = 'rgba(127,127,127,0.14)'; },
            onMouseLeave: function (event) { event.currentTarget.style.opacity = ''; event.currentTarget.style.background = 'transparent'; },
            style: Object.assign({}, ST.iconButton, ready ? null : ST.iconButtonOff),
          }, h(Glyph));

      return h('span', {
        ref: anchorRef,
        style: ST.anchor,
        onMouseEnter: function () {
          if (!sessionId) return;
          cancelHoverClose();
          if (!slotOf(sessionId).panelOpen) openPanel(sessionId);
        },
        onMouseLeave: function () {
          if (!sessionId) return;
          cancelHoverClose();
          hoverTimer.current = setTimeout(function () {
            hoverTimer.current = null;
            const current = slotOf(sessionId);
            if (!current.panelOpen) return;
            // A pinned card stays up until the clock is clicked again.
            if (current.pinned) return;
            // Keep it open while the user is typing in the clock form, and keep a
            // red error on screen long enough to be read.
            const active = typeof document !== 'undefined' ? document.activeElement : null;
            const tag = active && active.tagName;
            if (current.error) return;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            closePanel(sessionId);
          }, 300);
        },
      },
        clock,
        s.panelOpen
          ? h(Card, { sessionId: sessionId, draft: draft })
          : null
      );
    }

    /** The small setting popover that hangs above the clock button. */
    function Card(props) {
      const sessionId = props.sessionId;
      const draft = typeof props.draft === 'string' ? props.draft : '';
      const s = useSlot(sessionId);
      if (!sessionId) return null;

      const text = draft.trim();
      const slots = presetSlots();
      const clock = parseTimeText(s.timeText);
      const wall = plannedAt(sessionId, false);
      const canConfirm = !!text && !!clock && !s.busy;

      let when = '';
      if (!s.timeText) when = '默认十分钟后，可以直接改写';
      else if (!clock) when = '写成 12:30，或者直接写 1230、930';
      else if (rollsOver(sessionId)) when = '今天这个时刻过了，会顺延到明天';
      else if (wall) when = '将在 ' + formatWhen(wall) + ' 发出';

      const daySelect = h('select', {
        value: String(typeof s.day === 'number' ? s.day : 0),
        'aria-label': '日期',
        style: ST.select,
        onChange: function (event) {
          patch(sessionId, { day: Number(event.target.value), error: '' });
        },
      }, DAY_OPTIONS.map(function (offset) {
        return h('option', { key: offset, value: String(offset), style: ST.option }, dayLabel(offset));
      }));

      const timeInput = h('input', {
        type: 'text',
        value: s.timeText || '',
        placeholder: '12:30',
        maxLength: 5,
        inputMode: 'numeric',
        'aria-label': '时间',
        title: '手写时刻，12:30 / 1230 / 930 都认',
        style: Object.assign({}, ST.field, clock ? null : ST.fieldBad),
        onChange: function (event) { patch(sessionId, { timeText: event.target.value, error: '' }); },
        onKeyDown: function (event) {
          if (event.key === 'Enter' && canConfirm) submit(sessionId, draft);
        },
      });

      return h('div', {
        style: Object.assign({}, ST.layer, accentVars()),
        role: 'dialog',
        'aria-label': '定时发送设置',
      },
        h('div', { style: ST.popBridge }),
        h('div', { style: ST.popTip }),
        h('div', { style: ST.pop },
        h('div', { style: ST.popHead },
          h('span', { style: ST.popTitle }, h(Glyph, { size: 13 }), '定时发送'),
          h('div', { style: ST.popRow },
            h(ThemeDots, null),
            h('button', {
              type: 'button', style: ST.close, title: '收起', 'aria-label': '收起',
              onClick: function () { closePanel(sessionId); },
            }, '✕')
          )
        ),

        h('span', { style: ST.hint },
          s.task
            ? '已有一条：' + (s.task.at ? formatWhen(s.task.at) : '定时中') + '，再设一次就是改期'
            : '到点由 DSH 把这条消息发到当前会话'
        ),

        // Two cheap windows stay one press away; "自己定时" unfolds the clock form.
        s.custom ? null : h('div', { style: ST.popRow },
          slots.map(function (slot) {
            return h(QuickSlot, {
              key: slot.time,
              slot: slot,
              busy: s.busy,
              onPick: function (picked) { submit(sessionId, draft, picked); },
            });
          }),
          h('button', {
            type: 'button', style: ST.link, title: '自己定时',
            onClick: function () { patch(sessionId, { custom: true, error: '' }); },
          }, '自己定时')
        ),

        s.custom ? h('div', { style: ST.popRow },
          daySelect,
          timeInput,
          h('button', {
            type: 'button',
            disabled: !canConfirm,
            title: text ? (clock ? '按这个时间发送' : '时间还没写对') : '输入框是空的',
            onClick: function () { submit(sessionId, draft); },
            style: Object.assign({}, ST.primary, !canConfirm ? ST.primaryOff : null),
          }, s.busy ? '设定中…' : '定时发送'),
          h('button', {
            type: 'button', style: ST.link, title: '收起',
            onClick: function () { patch(sessionId, { custom: false, error: '' }); },
          }, '收起')
        ) : null,

        s.custom ? h('span', { style: ST.hint }, when) : null,
        s.error ? h('div', { style: ST.error, role: 'alert' }, s.error) : null
        )
      );
    }

    /** One of the two cheap windows: pressing it schedules immediately. */
    /** Three dots: follow the DSH theme, warm orange, DeepSeek blue. */
    function ThemeDots() {
      const current = themeOf();
      return h('div', { style: ST.dots, role: 'group', 'aria-label': '主题颜色' },
        THEMES.map(function (theme) {
          const on = theme.id === current.id;
          return h('button', {
            key: theme.id,
            type: 'button',
            title: theme.label,
            'aria-label': theme.label,
            'aria-pressed': on ? 'true' : 'false',
            onClick: function () { setTheme(theme.id); },
            style: Object.assign(
              {},
              ST.dot,
              theme.dot ? { background: theme.dot, borderColor: theme.dot } : null,
              on ? ST.dotOn : null
            ),
          });
        })
      );
    }

    /** One of the two cheap windows: a compact confirm button, press to send. */
    function QuickSlot(props) {
      const slot = props.slot;
      return h('button', {
        type: 'button',
        disabled: props.busy,
        title: '立刻排到 ' + slot.label,
        'aria-label': '立刻排到 ' + slot.label,
        onClick: function () { props.onPick(slotWall(slot)); },
        style: Object.assign({}, ST.quick, props.busy ? ST.quickOff : null),
      },
        h('span', { style: ST.quickTime }, slot.time),
        h('span', { style: ST.quickDay }, dayLabel(slot.day))
      );
    }


    // A broken render must not take the composer down with it.
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.warn('[dsh-auto-send]', error); } catch (_) {} }
      render() { return this.state.failed ? null : this.props.children; }
    }

    function guard(Component) {
      return function Guarded(props) {
        return h(Boundary, null, h(Component, props));
      };
    }

    return {
      inject: ['slots', 'remote', 'remote.schedule'],
      apply(ctx) {
        HOST = ctx;
        try {
          if (ctx.remote && typeof ctx.remote.$on === 'function') ctx.remote.$on('schedule/changed', refreshAll);
        } catch (_) { /* an older Host without the event bus still works */ }
        try {
          if (typeof ctx.on === 'function') ctx.on('connection/reset', refreshAll);
        } catch (_) { /* same */ }
        ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register(
            { name: 'conversation.input.right', id: 'auto-send-button', order: 40, label: '定时发送' },
            guard(SendButton)
          );
        });
      },
    };
  },
});

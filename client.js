window.__ModuleLoader__.load({
  id: '@local/dsh-phone-remote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const PANEL_KEY = 'phone-console';
    const API = '/api/phone-remote';
    // apply 里赋值，组件经闭包读取服务；React 组件内没有 this.ctx。
    let ctxRef = null;

    /**
     * 机器人设置区（boss 2026-10-20 定·永久）：
     * 「绑定了机器人，必须强制选择工作区作为默认会话的渠道；不选择，不能开启该功能。」
     *
     * 界面上这道闸 + 后端那道闸（后端拒绝才是真的）一起管。
     */
    function BotSetup() {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [wsChoice, setWsChoice] = useState('');

      const load = async () => {
        try {
          const res = await fetch(API + '/bot-setup', { cache: 'no-store' });
          const body = await res.json();
          setState(body);
          setWsChoice((prev) => prev || String(body?.workspaceId || ''));
        } catch (e) {
          setMsg('读不到设置：' + String(e?.message ?? e));
        }
      };

      useEffect(() => { load(); }, []);

      const save = async (patch) => {
        setBusy(true);
        setMsg(null);
        try {
          // ⚠️ 正文走 header（10-20 22:53 实测）：DSH 的 gzip 中间件用
          //   Object.create(req) 造替身读流，把 body 吃掉了 → 插件收不到参数。
          const payload = JSON.stringify(patch);
          const res = await fetch(API + '/bot-setup', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-bot-payload': encodeURIComponent(payload),
            },
            body: payload,
          });
          const body = await res.json();
          if (!body?.ok) {
            setMsg(body?.error || '保存失败');
          } else {
            setMsg('已保存');
          }
          await load();
        } catch (e) {
          setMsg('保存失败：' + String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      if (!state) {
        return h('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 10 } }, '正在读机器人设置…');
      }

      const workspaces = state.workspaces || [];
      const bound = Boolean(state.bound);
      const picked = String(state.workspaceId || '');
      // 没选工作区 → 不给开（按钮禁用 + 说清为什么）
      const canEnable = !bound || Boolean(picked);
      const needPick = bound && !picked;

      return h(
        'div',
        {
          style: {
            marginBottom: 16, padding: '12px 14px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-interface-primary-border-color, rgba(127,127,127,.35))',
          },
        },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '机器人（企业微信）'),

        h('div', { style: { fontSize: 12, opacity: 0.8, marginBottom: 8, lineHeight: 1.6 } },
          '机器人从手机发过来的话，会在下面选的工作区里开会话并干活。',
          h('br'),
          h('b', { style: { fontWeight: 600 } }, '绑定机器人前必须先选工作区，没选不能开启。')),

        h('div', { style: { fontSize: 12, marginBottom: 6 } }, '默认工作区'),
        h(
          'select',
          {
            value: wsChoice,
            disabled: busy,
            onChange: (e) => setWsChoice(e.target.value),
            style: {
              width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 8,
              border: '1px solid var(--dsw-alias-interface-primary-border-color, rgba(127,127,127,.4))',
              background: 'transparent', color: 'var(--dsw-alias-body-text-color, inherit)',
            },
          },
          h('option', { value: '' }, '— 请选择一个工作区 —'),
          workspaces.map((w) => h('option', { key: w.id, value: w.id },
            w.title + '（' + w.sessionCount + ' 个会话）')),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' } },
          h(
            'button',
            {
              disabled: busy || !wsChoice,
              onClick: () => save({ workspaceId: wsChoice }),
              style: {
                fontSize: 13, padding: '5px 12px', borderRadius: 8, cursor: busy || !wsChoice ? 'not-allowed' : 'pointer',
                border: '1px solid var(--dsw-alias-interface-primary-border-color, rgba(127,127,127,.4))',
                background: 'transparent', color: 'var(--dsw-alias-body-text-color, inherit)',
                opacity: busy || !wsChoice ? 0.5 : 1,
              },
            },
            '保存工作区',
          ),
          h(
            'button',
            {
              disabled: busy || !canEnable,
              onClick: () => save({ bound: !bound }),
              title: needPick ? '先选一个工作区才能开启' : '',
              style: {
                fontSize: 13, padding: '5px 12px', borderRadius: 8, cursor: busy || !canEnable ? 'not-allowed' : 'pointer',
                border: '1px solid var(--dsw-alias-interface-primary-border-color, rgba(127,127,127,.4))',
                background: 'transparent', color: 'var(--dsw-alias-body-text-color, inherit)',
                opacity: busy || !canEnable ? 0.5 : 1,
              },
            },
            bound ? '停用机器人' : '启用机器人',
          ),
          h('span', { style: { fontSize: 12, opacity: 0.75 } },
            bound ? '当前：已绑定' : '当前：未绑定',
            picked ? '，工作区＝' + (state.workspaceTitle || picked) : ''),
        ),

        needPick
          ? h('div', { style: { fontSize: 12, marginTop: 8, color: 'var(--dsw-alias-warning-color, #c06a1a)' } },
              '还没选工作区 —— 机器人功能现在是关着的，选一个才能开。')
          : null,

        msg
          ? h('div', { style: { fontSize: 12, marginTop: 8, opacity: 0.8 } }, msg)
          : null,
      );
    }

    function SessionRow({ session, onOpen }) {
      const busy = Boolean(session.running);
      return h(
        'button',
        {
          onClick: () => onOpen(session),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
            background: 'transparent', border: 'none', textAlign: 'left',
            color: 'var(--dsw-alias-body-text-color, inherit)',
          },
        },
        h('span', {
          style: {
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: busy ? 'var(--dsw-alias-warning-color, #e8862c)' : 'var(--dsw-alias-success-color, #0d9458)',
          },
        }),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 } },
          session.title || session.id),
        h('span', { style: { fontSize: 12, opacity: 0.6, flexShrink: 0 } }, busy ? '忙' : '闲'),
      );
    }

    function Console() {
      const [groups, setGroups] = useState([]);
      const [error, setError] = useState(null);
      const [loaded, setLoaded] = useState(false);

      useEffect(() => {
        let alive = true;
        let timer = null;
        const refresh = async () => {
          try {
            const result = await ctxRef.sessions.search('', new AbortController().signal);
            const items = result?.ok ? result.value.items : [];
            const byWorkspace = new Map();
            for (const s of items || []) {
              const w = String(s.workspaceId || 'default');
              if (!byWorkspace.has(w)) byWorkspace.set(w, []);
              byWorkspace.get(w).push(s);
            }
            const rows = [];
            for (const [wid, wsItems] of byWorkspace) rows.push({ workspaceId: wid, items: wsItems });
            if (alive) {
              setGroups(rows);
              setLoaded(true);
              setError(null);
            }
          } catch (cause) {
            if (alive) setError(String(cause?.message ?? cause));
          }
        };
        refresh();
        timer = setInterval(refresh, 5000);
        return () => {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, []);

      const openSession = (session) => {
        try {
          ctxRef.uiWorkspace.openSession(session.id);
          ctxRef.layout.selectPanel('conversation');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      // <你的工作区>工作区（boss 2026-10-20 定：指挥台进来的会话默认归<你的工作区>）。
      // id 来自 DSH 自己的工作区注册表 ~/.dsh/storages/workspace.json
      // （title=<你的工作区> / path=<你的数据目录>\<你的工作区>）。换工作区或重建后要同步改这里。
      const DEFAULT_WORKSPACE_ID = '35db73aa-b637-4d9b-9ed8-7d77c0a0285b'

      const newSession = async (workspaceId) => {
        try {
          // 「默认落<你的工作区>」只兜底，不抢用户的明确选择：
          //   · 点在某个具体分组的「＋」→ 用那个分组的工作区（明确意图，照办）；
          //   · 点是 default 兜底组 / 分组信息缺失 → 落<你的工作区>。
          // 兜底前先验一下这个 id 在不在已知工作区里（从会话清单反推）：
          // 不在就退回老行为，绝不把按钮点坏。
          let target = workspaceId
          if (!target || target === 'default') {
            const known = new Set(groups.map((g) => g.workspaceId))
            target = known.has(DEFAULT_WORKSPACE_ID) ? DEFAULT_WORKSPACE_ID : undefined
          }
          await ctxRef.uiWorkspace.connectWorkspace(target === undefined ? undefined : target, { agentPreset: 'standard' });
          ctxRef.layout.selectPanel('conversation');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      return h(
        'div',
        { style: { padding: '16px 14px 40px', maxWidth: 640, margin: '0 auto', fontFamily: 'var(--dsh-font-family-ui, inherit)' } },
        h('h2', { style: { fontSize: 18, fontWeight: 600, margin: '4px 0 14px' } }, '手机远程'),
        h(BotSetup),
        error && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-warning-color, #c06a1a)', marginBottom: 8 } }, '提示：' + error),
        !loaded && !error && h('div', { style: { fontSize: 13, opacity: 0.7 } }, '正在连接…'),
        loaded && groups.length === 0 && h('div', { style: { fontSize: 13, opacity: 0.7 } }, '暂无会话。'),
        groups.map((group) =>
          h(
            'section',
            { key: group.workspaceId, style: { marginBottom: 18 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
              h('h3', { style: { fontSize: 14, fontWeight: 600, margin: 0 } }, '工作区 ' + group.workspaceId),
              h(
                'button',
                {
                  onClick: () => newSession(group.workspaceId),
                  style: { fontSize: 12, padding: '4px 10px', borderRadius: 8, cursor: 'pointer',
                           border: '1px solid var(--dsw-alias-interface-primary-border-color, #999)',
                           background: 'transparent', color: 'var(--dsw-alias-body-text-color, inherit)' },
                },
                '＋ 新会话',
              ),
            ),
            group.items.map((s) => h(SessionRow, { key: s.id, session: s, onOpen: openSession })),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        ctxRef = ctx;
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, Console),
        );
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'phone-console-entry', order: 10 },
            () => h(
              'button',
              {
                onClick: () => ctx.layout.selectPanel(PANEL_KEY),
                title: '手机远程',
                style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                         padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                         border: 'none', background: 'transparent',
                         color: 'var(--dsw-alias-body-text-color, inherit)' },
              },
              // 图标跟插件本体一致（手机+信号波，见 icon.svg），
              // 文字也跟插件本体一致叫「手机远程」——2026-10-20 boss定：
              // 侧边栏这里原来写「📱 指挥台」，跟系统插件里的「手机远程」
              // 名字和图标两套对不上，统一到插件这一套。
              h('span', {
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                         width: 16, height: 16, flexShrink: 0, lineHeight: 0 },
              }, h(
                'svg',
                { viewBox: '0 0 64 64', width: 16, height: 16, 'aria-hidden': true,
                  style: { display: 'block', overflow: 'visible' } },
                h('rect', { x: 18, y: 6, width: 28, height: 52, rx: 5, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
                h('line', { x1: 27, y1: 50, x2: 37, y2: 50, stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }),
                h('path', { d: 'M46 18 q10 6 10 16', fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }),
                h('path', { d: 'M46 10 q16 9 16 24', fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', opacity: 0.5 }),
                h('circle', { cx: 32, cy: 24, r: 6, fill: 'currentColor' }),
              )),
              h('span', { style: { fontSize: 14 } }, '手机远程'),
            ),
          ),
        );
        return () => {
          ctxRef = null;
        };
      },
    };
  },
});

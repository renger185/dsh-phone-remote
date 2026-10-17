window.__ModuleLoader__.load({
  id: '@local/dsh-phone-remote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const PANEL_KEY = 'phone-console';
    // apply 里赋值，组件经闭包读取服务；React 组件内没有 this.ctx。
    let ctxRef = null;

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

      const newSession = async (workspaceId) => {
        try {
          await ctxRef.uiWorkspace.connectWorkspace(workspaceId === 'default' ? undefined : workspaceId, { agentPreset: 'standard' });
          ctxRef.layout.selectPanel('conversation');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      return h(
        'div',
        { style: { padding: '16px 14px 40px', maxWidth: 640, margin: '0 auto', fontFamily: 'var(--dsh-font-family-ui, inherit)' } },
        h('h2', { style: { fontSize: 18, fontWeight: 600, margin: '4px 0 14px' } }, '手机指挥台'),
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
                title: '手机指挥台',
                style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                         padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                         border: 'none', background: 'transparent',
                         color: 'var(--dsw-alias-body-text-color, inherit)' },
              },
              h('span', { style: { fontSize: 14 } }, '📱 指挥台'),
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

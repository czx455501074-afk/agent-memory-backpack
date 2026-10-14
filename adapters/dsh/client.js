window.__ModuleLoader__.load({
  id: "dsh-agent-memory-backpack",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    exports.name = "dsh-agent-memory-backpack";
    exports.inject = ["slots"];

    function KnowledgeTabView() {
      var [src, setSrc] = React.useState("http://127.0.0.1:47631/ui");
      var iframeRef = React.useRef(null);

      React.useEffect(() => {
        fetch("/amb/ui-url")
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data && data.url) {
              setSrc(data.url);
            }
          })
          .catch(() => {});
      }, []);

      var handleRefresh = () => {
        if (iframeRef.current) {
          try {
            iframeRef.current.contentWindow.location.reload();
          } catch (e) {
            iframeRef.current.src = src;
          }
        }
      };

      return React.createElement("div", {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          backgroundColor: "var(--dsh-bg-base, #101319)"
        }
      }, [
        React.createElement("div", {
          key: "toolbar",
          style: {
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--dsh-border-subtle, rgba(255,255,255,0.08))",
            backgroundColor: "var(--dsh-bg-surface, rgba(255,255,255,0.02))",
            fontSize: "12px",
            color: "var(--dsh-text-muted, #8b949e)"
          }
        }, [
          React.createElement("div", {
            key: "left",
            style: { display: "flex", alignItems: "center", gap: "8px" }
          }, [
            React.createElement("span", {
              key: "dot",
              style: {
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "#10b981"
              }
            }),
            React.createElement("span", {
              key: "title",
              style: { fontWeight: "bold", color: "var(--dsh-text-primary, #e6edf3)" }
            }, "Agent Memory Backpack · 共享知识库"),
            React.createElement("span", { key: "port", style: { opacity: 0.7 } }, "(核心端口: 47631)")
          ]),
          React.createElement("div", {
            key: "right",
            style: { display: "flex", alignItems: "center", gap: "8px" }
          }, [
            React.createElement("button", {
              key: "refresh-btn",
              onClick: handleRefresh,
              style: {
                background: "none",
                border: "1px solid var(--dsh-border-subtle, rgba(255,255,255,0.15))",
                borderRadius: "4px",
                padding: "3px 10px",
                color: "var(--dsh-text-primary, #e6edf3)",
                cursor: "pointer",
                fontSize: "12px"
              }
            }, "刷新"),
            React.createElement("a", {
              key: "open-btn",
              href: src,
              target: "_blank",
              rel: "noreferrer",
              style: {
                color: "var(--dsh-text-link, #58a6ff)",
                textDecoration: "none",
                padding: "3px 8px",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px"
              }
            }, "新窗口打开 ↗")
          ])
        ]),
        React.createElement("iframe", {
          key: "content-frame",
          ref: iframeRef,
          src: src,
          style: {
            width: "100%",
            height: "100%",
            border: "none",
            flex: 1
          }
        })
      ]);
    }

    exports.apply = (ctx) => {
      ctx.slots.inject("conversation.view", () => {
        return ctx.slots.register({
          name: "conversation.view",
          id: "amb-knowledge-view",
          order: 25,
          label: () => "AMB 知识库",
        }, () => React.createElement(KnowledgeTabView));
      });
    };

    return module.exports;
  }
});

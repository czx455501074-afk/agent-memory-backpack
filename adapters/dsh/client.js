window.__ModuleLoader__.load({
  id: "dsh-agent-memory-backpack",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    /**
     * Browser half of the AMB DSH adapter.
     *
     * The knowledge surface is a native React panel contributed to the host's
     * `conversation.view` slot: it renders inside the harness document, so it
     * inherits the host theme tokens and light/dark switching directly. No
     * embedded document, second application root, or host-served page is used.
     */
    var PLUGIN_ID = "dsh-agent-memory-backpack";
    var VIEW_SLOT = "conversation.view";
    var VIEW_ID = "amb-knowledge-view";
    var VIEW_ORDER = 25;
    var ROOT_CLASS = "amb-knowledge-panel";
    var STYLE_TAG_ID = PLUGIN_ID + "/" + VIEW_ID + ".css";
    var SEARCH_LIMIT = 20;

    /**
     * The knowledge categories the panel navigates, in the order it lists them.
     *
     * These are the core's own `kind` values. The keys are stable namespaced copy
     * keys, so a category whose name needs translating is translated once, and the
     * badge prints the same word the group header does. A category the core adds
     * later does not appear here until this table names it.
     */
    var KIND_GUIDE_KEYS = [
      { kind: "skill", labelKey: "kind.skill.label", guideKey: "kind.skill.guide" },
      { kind: "journal", labelKey: "kind.journal.label", guideKey: "kind.journal.guide" },
      { kind: "material", labelKey: "kind.material.label", guideKey: "kind.material.guide" },
      { kind: "memory", labelKey: "kind.memory.label", guideKey: "kind.memory.guide" },
      { kind: "norm", labelKey: "kind.norm.label", guideKey: "kind.norm.guide" },
    ];

    /**
     * The task states the panel groups by, in the order it lists them. `status` is
     * the core's own task column; a state outside this table is still shown, under
     * its raw value, rather than being folded into another group.
     */
    var TASK_STATUS_KEYS = [
      { status: "in_progress", labelKey: "task.status.inProgress" },
      { status: "paused", labelKey: "task.status.paused" },
      { status: "completed", labelKey: "task.status.completed" },
      { status: "failed", labelKey: "task.status.failed" },
      { status: "cancelled", labelKey: "task.status.cancelled" },
    ];

    /**
     * The views the reader can switch between, mirroring the category-tab idea from
     * the memory-evolve board: one navigation row, one grouped body per view, and a
     * short guide line saying what the view is for.
     */
    var VIEW_KEYS = ["all", "kinds", "review", "tasks", "manage"];

    /** Badge copy keys for the states a knowledge entry can report. */
    var ENTRY_STATUS_KEYS = {
      active: "entry.status.active",
      archived: "entry.status.archived",
      retired: "entry.status.retired",
    };

    /**
     * Host routes this panel reads. The adapter owns these routes; the panel
     * never writes them. Contract the host half must satisfy:
     *
     *   GET /amb/summary
     *     -> { ok: boolean,
     *          core: { reachable: boolean, endpoint: string, projectId: string, reason?: string },
     *          revision: number,
     *          counts: { knowledge: number, pendingProposals: number,
     *                    outbox: { pending: number, failed: number, abandoned: number } },
     *          knowledge?: Array<{ id, kind, title, scope?, updatedAt? }> }
     *
     *   GET /amb/search?q=<query>&limit=<n>
     *     -> { ok: boolean, results: Array<{ id, kind, title, excerpt? }> }
     *
     *   GET /amb/task?taskId=<id>
     *     -> { ok: boolean, task?: { id, title, status, summary?, updatedAt? } }
     *
     * `ok !== true`, a non-JSON body, a missing required field, or a transport
     * failure each produce a distinct, visible failure state with the raw reason
     * and a retry control. Optional fields degrade instead of failing the panel:
     * a missing `knowledge` array and a missing `counts.outbox` render explicit
     * placeholders rather than invented zeroes.
     */
    var ENDPOINTS = {
      summary: "/amb/summary",
      search: "/amb/search",
      task: "/amb/task",
    };

    /**
     * The management routes.
     *
     * The panel names an *action*; the host half resolves it against its own
     * allow-list and performs it with the admin credential, which never reaches this
     * side. Nothing here is a core path - that mapping lives in the host, so a panel
     * bug cannot widen what the credential may reach.
     *
     *   POST /amb/admin/<action>   body: the core's own parameters
     *     -> { ok: boolean, action: string, data?: unknown, error?: string,
     *          admin?: { available: boolean } }
     *
     * `ok !== true` together with `admin.available === false` means this machine has
     * no admin credential. That is a capability the panel reports as unavailable, not
     * a transport failure, so the two must never be rendered the same way.
     */
    var ADMIN_PREFIX = "/amb/admin/";

    /**
     * Chinese copy keyed by stable namespaced keys. A future localization pass
     * swaps this table for the client locale service without touching call sites.
     */
    var MESSAGES = {
      "panel.tab": "AMB 知识库",
      "status.reachable": "核心可达",
      "status.unreachable": "核心不可达",
      "status.unavailable": "知识库数据不可用",
      "status.checking": "正在连接知识库核心",
      "status.checkingDetail": "正在读取概览数据，请稍候。",
      "status.project": "项目",
      "status.revision": "知识版本",
      "status.unreachableReason": "核心未报告不可达原因。",
      "status.unknown": "未知",
      "action.refresh": "刷新",
      "action.refreshing": "刷新中",
      "action.retry": "重试",
      "action.search": "搜索",
      "section.overview": "概览",
      "section.search": "知识搜索",
      "section.knowledge": "知识条目",
      "section.tasks": "任务记录",
      "count.knowledge": "知识条目",
      "count.pendingProposals": "待审候选",
      "queue.pending": "队列待发",
      "queue.failed": "发送失败",
      "queue.abandoned": "已放弃",
      "state.loading": "正在加载…",
      "state.noData": "端点没有返回概览数据。",
      "state.emptyKnowledge": "核心未返回知识条目。",
      "state.emptySearch": "没有匹配的知识条目。",
      "state.emptySearchHint": "换一个关键词再试。",
      "state.searchIdle": "输入关键词后按回车或点击搜索。",
      "state.fieldWarning": "响应缺少部分计数字段，以上“—” 表示该字段未提供。",
      "search.placeholder": "搜索共享知识库",
      "search.pending": "正在搜索…",
      "view.nav": "视角",
      "view.all": "全部",
      "view.kinds": "按类别",
      "view.review": "待审",
      "view.tasks": "任务",
      "view.manage": "管理",
      "view.guide.all": "本凭据可见的全部有效条目，平铺展示，不分组。",
      "view.guide.kinds": "按知识类别分组浏览，每组给出用途说明、条目数与可折叠列表。",
      "view.guide.review": "AI 写入的候选先进待确认队列，采纳或拒绝由你决定；操作在「管理」视角进行。",
      "view.guide.tasks": "当前项目的任务记录，按核心报告的状态分组。",
      "view.guide.manage": "需要管理员凭据的操作：迁移（导出/导入）与候选复核。凭据只留在宿主进程内，页面拿不到它。",
      "scope.notice": "作用域：全局共享知识库，不按项目隔离；列表按本凭据的项目可见范围返回。",
      "scope.library": "全库有效条目",
      "scope.visible": "当前项目可见",
      "group.collapse": "折叠",
      "group.expand": "展开",
      "group.count": "条",
      "kind.skill.label": "技能",
      "kind.skill.guide": "可复用的操作方法与实践流程，经实战确认后沉淀。",
      "kind.journal.label": "日记",
      "kind.journal.guide": "会话与任务的经历记录，用于回溯当时的判断与结论。",
      "kind.material.label": "资料",
      "kind.material.guide": "外部参考材料，带来源地址，会随保存期到期。",
      "kind.memory.label": "记忆",
      "kind.memory.guide": "跨会话需要长期保留的稳定事实与偏好。",
      "kind.norm.label": "规范",
      "kind.norm.guide": "必须遵守的硬规则，风险最高，变更需人工确认。",
      "task.status.inProgress": "进行中",
      "task.status.paused": "已暂停",
      "task.status.completed": "已完成",
      "task.status.failed": "已失败",
      "task.status.cancelled": "已取消",
      "badge.kind": "类别",
      "badge.status": "状态",
      "badge.source": "作用域",
      "badge.project": "项目",
      "badge.limit": "上限",
      "badge.unknown": "未标注",
      "entry.status.active": "生效中",
      "entry.status.archived": "已归档",
      "entry.status.retired": "已退役",
      "entry.status.other": "其它状态",
      "entry.source.global": "全局",
      "entry.source.project": "项目",
      "entry.source.session": "会话",
      "entry.source.unknown": "来源未提供",
      "entry.source.proposal": "来自候选",
      "entry.statusMissing": "核心未返回该条目的状态。",
      "entry.proposalStateMissing": "核心未返回该条目的候选状态。",
      "entry.noFields": "未提供",
      "review.title": "待审候选",
      "review.pending": "待审",
      "review.approved": "已采纳",
      "review.archived": "已归档",
      "review.onlyDisplay": "这里的计数仅供浏览；采纳、拒绝与归档请到「管理」视图，那里需要管理员凭据。",
      "review.readableNote": "适配器凭据只能读取待审计数；已采纳与已归档需要管理员凭据，这里显示为「未提供」而不是猜一个 0。",
      "review.empty": "当前项目没有待审候选。",
      "review.unavailable": "核心未返回候选计数。",
      "review.origin": "候选来源",
      "review.originValue": "配置中声明的核心地址与项目引用的候选队列",

      // The management view. Every action below needs the admin credential, which
      // stays inside the host process; the copy says so rather than implying the page
      // holds it.
      "manage.title": "管理与迁移",
      "manage.credentialMissing": "未找到管理凭据（admin-client.json），管理功能不可用。把该文件放在数据目录下即可启用。",
      "manage.backupTitle": "库迁移（导出 / 导入）",
      "manage.backupNote": "导出会一次读出整个知识库；导入会直接写入有效库，绕过候选队列与项目范围检查。两者都只应由你本人执行。",
      "manage.export": "导出整个库",
      "manage.exporting": "正在导出…",
      "manage.exportDone": "导出完成",
      "manage.importPath": "要导入的 .ambpack 路径",
      "manage.inspect": "先预览内容",
      "manage.inspecting": "正在读取…",
      "manage.inspectTitle": "将要导入的内容",
      "manage.import": "确认导入",
      "manage.importing": "正在导入…",
      "manage.importDone": "导入完成",
      "manage.pathRequired": "请先填写要导入的文件路径。",
      "manage.proposalsTitle": "候选复核",
      "manage.proposalsNote": "这里的每个操作都会改变有效知识库，并且需要管理员凭据；操作会记入插件日志。",
      "manage.composeKind": "把它存成哪一类",
      "manage.composeTitle": "标题",
      "manage.composeNote": "候选本身只有一段待核实的文本，没有知识条目形态。选定类别与标题后，「确认采纳」才会把它写进有效库——这一步的判断只能由人来做。",
      "manage.approveConfirmed": "确认采纳",
      "manage.cancel": "取消",
      "manage.submittedAt": "提交于",
      "manage.fromTask": "来自任务",
      "manage.chars": "字",
      "manage.noContent": "（这条候选没有正文）",
      "manage.justNow": "刚刚",
      "manage.minutesAgo": " 分钟前",
      "manage.hoursAgo": " 小时前",
      "manage.daysAgo": " 天前",
      "manage.approve": "采纳",
      "manage.reject": "拒绝",
      "manage.archive": "归档",
      "manage.confirm": "此操作会改变有效知识库，确认执行？",
      "manage.loading": "正在读取候选…",
      "manage.empty": "没有待审候选。",
      "manage.actionDone": "操作完成",
      "manage.unavailable": "核心未返回候选列表。",
      "tasks.groupEmpty": "该状态下没有任务记录。",
      "tasks.projectMissing": "核心未返回任务所属项目。",
      "tasks.evidence": "证据级别",
      "tasks.unavailable": "任务列表暂时未提供。",
      "tasks.countNote": "核心报告的任务计数覆盖全库，此处列表按本项目过滤。",
      "tasks.empty": "当前项目没有任务记录。",
      "state.emptyAll": "核心未返回知识条目。",
      "state.emptyKind": "该类别目前没有条目。",
      "state.kindFailed": "该类别读取失败。",
      "state.facetsMissing": "响应未包含类别分组数据，已退回平铺列表。",
      "entry.scope": "范围",
      "entry.updated": "更新时间",
      "entry.expandHint": "点击查看详情",
      "entry.timeUnknown": "未提供",
      "entry.excerptMissing": "概览响应未包含该条目的摘要。",
      "entry.taskLoading": "正在读取任务记录…",
      "entry.taskMissing": "未找到该任务记录。",
      "entry.taskStatus": "状态",
      "entry.taskSummary": "摘要",
      "kind.unknown": "未知",
      "error.unknown": "未知错误",
      "error.network": "网络请求失败",
      "error.transport": "请求无法发出",
      "error.http": "端点返回错误状态",
      "error.parse": "端点返回的内容不是 JSON",
      "error.payload": "端点响应缺少必需字段",
      "error.notOk": "端点报告失败",
      "error.detail": "原始原因",
      "error.noFetch": "当前环境没有可用的 fetch 实现。",
      "error.badResponse": "fetch 返回了无效的响应对象。",
      "error.summaryShape": "概览响应格式不符合约定",
      "error.searchShape": "搜索响应格式不符合约定",
      "error.taskShape": "任务响应格式不符合约定",
      "error.taskId": "缺少任务标识，无法查询任务记录。",
      "error.adminShape": "管理端点响应格式不符合约定",
      "error.render": "面板渲染失败",
      "slot.unavailable": "会话视图插槽不可用，AMB 知识库面板未注册。",
    };

    /** Resolve one message; an unknown key returns itself so gaps stay visible. */
    function t(key) {
      return Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : key;
    }

    function warn(message) {
      try {
        if (typeof console !== "undefined" && console && typeof console.warn === "function") {
          console.warn("[amb] " + message);
        }
      } catch (ignored) {
        // A missing or hostile console must never break plugin activation.
      }
    }

    function describeThrown(error) {
      if (error === null || error === undefined) return "unknown";
      if (typeof error === "string") return error;
      if (error && typeof error.message === "string" && error.message !== "") {
        return typeof error.name === "string" && error.name !== ""
          ? error.name + ": " + error.message
          : error.message;
      }
      try {
        return JSON.stringify(error);
      } catch (ignored) {
        return String(error);
      }
    }

    /**
     * The text a candidate carries.
     *
     * Candidates are text-only by schema (the proposal schema is strict and has no entry
     * field), and that text lands in one of two places depending on who submitted it: the
     * core mirrors it to the top level, while the payload keeps the original submission.
     * Read both, so neither shape renders as an empty row - which is exactly what a
     * reviewer saw when this row was drawn from a `title` field that does not exist.
     */
    function proposalText(proposal) {
      if (!proposal) return "";
      if (typeof proposal.discovery === "string" && proposal.discovery !== "") return proposal.discovery;
      var payload = proposal.payload;
      if (payload && typeof payload.discovery === "string") return payload.discovery;
      return "";
    }

    /** "3 分钟前" - a time a reviewer can act on without doing arithmetic. */
    function relativeTime(value, t) {
      var ms = typeof value === "number" ? value : Date.parse(String(value));
      if (!isFinite(ms)) return "";
      var minutes = Math.floor((Date.now() - ms) / 60000);
      if (minutes < 1) return t("manage.justNow");
      if (minutes < 60) return minutes + t("manage.minutesAgo");
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + t("manage.hoursAgo");
      return Math.floor(hours / 24) + t("manage.daysAgo");
    }

    function previewText(text) {
      var normalized = String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim();
      return normalized.length > 120 ? normalized.slice(0, 120) + "…" : normalized;
    }

    function stringOr(value, fallback) {
      return typeof value === "string" && value !== "" ? value : fallback;
    }

    function numberOrNull(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /** A panel-visible failure: a message key plus the raw underlying reason. */
    function makeFailure(kind, messageKey, detail) {
      return {
        ambFailure: true,
        kind: kind,
        messageKey: messageKey,
        detail: detail === null || detail === undefined ? "" : String(detail).slice(0, 400),
      };
    }

    function isFailure(value) {
      return Boolean(value) && typeof value === "object" && value.ambFailure === true;
    }

    function toFailure(value) {
      return isFailure(value) ? value : makeFailure("transport", "error.unknown", describeThrown(value));
    }

    /** The fetch implementation of the surrounding document, when it has one. */
    function resolveFetch() {
      if (typeof globalThis === "object" && globalThis !== null && typeof globalThis.fetch === "function") {
        return globalThis.fetch;
      }
      if (typeof window !== "undefined" && window && typeof window.fetch === "function") {
        return window.fetch.bind(window);
      }
      return null;
    }

    /**
     * Read one JSON endpoint and classify every failure mode the panel reports:
     * transport, network, HTTP status, non-JSON body. The body is never trusted
     * before it parses, and the raw reason is preserved for the failure state.
     */
    function requestJson(path, fetchImpl) {
      if (typeof fetchImpl !== "function") {
        return Promise.reject(makeFailure("transport", "error.transport", t("error.noFetch")));
      }
      return new Promise(function (resolve, reject) {
        var pending;
        try {
          pending = fetchImpl(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
        } catch (error) {
          reject(makeFailure("network", "error.network", describeThrown(error)));
          return;
        }
        Promise.resolve(pending).then(
          function (response) {
            if (!response || typeof response !== "object") {
              reject(makeFailure("transport", "error.transport", t("error.badResponse")));
              return;
            }
            if (response.ok !== true) {
              reject(makeFailure(
                "http",
                "error.http",
                "HTTP " + String(response.status) + (response.statusText ? " " + String(response.statusText) : ""),
              ));
              return;
            }
            var body;
            try {
              body = response.text();
            } catch (error) {
              reject(makeFailure("parse", "error.parse", describeThrown(error)));
              return;
            }
            Promise.resolve(body).then(
              function (text) {
                try {
                  resolve(JSON.parse(String(text)));
                } catch (error) {
                  reject(makeFailure("parse", "error.parse", "HTTP " + String(response.status) + " · " + previewText(text)));
                }
              },
              function (error) {
                reject(makeFailure("parse", "error.parse", describeThrown(error)));
              },
            );
          },
          function (error) {
            reject(makeFailure("network", "error.network", describeThrown(error)));
          },
        );
      });
    }

    /**
     * The same request with a JSON body and POST - the shape `/amb/admin/<action>`
     * expects.
     *
     * Everything else matches `requestJson` deliberately: the same failure kinds, the
     * same immediate rejection on a non-2xx, the same "the body must parse as JSON"
     * rule. A management call that failed differently from a read call would be a
     * second failure vocabulary for the panel to explain.
     *
     * The host answers 200 with `ok:false` for a refusal (no admin credential, an
     * unlisted action, a core refusal), so this inspects the flag rather than trusting
     * the status code - which is exactly why the check is here and not at each caller.
     */
    function requestAdminJson(action, body, fetchImpl) {
      if (typeof fetchImpl !== "function") {
        return Promise.reject(makeFailure("transport", "error.transport", t("error.noFetch")));
      }
      var path = ADMIN_PREFIX + encodeURIComponent(action);
      var payload = JSON.stringify(body === undefined || body === null ? {} : body);
      return new Promise(function (resolve, reject) {
        var pending;
        try {
          pending = fetchImpl(path, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            credentials: "same-origin",
            body: payload,
          });
        } catch (error) {
          reject(makeFailure("network", "error.network", describeThrown(error)));
          return;
        }
        Promise.resolve(pending).then(
          function (response) {
            if (!response || typeof response !== "object") {
              reject(makeFailure("transport", "error.transport", t("error.badResponse")));
              return;
            }
            if (response.ok !== true) {
              reject(makeFailure(
                "http",
                "error.http",
                "HTTP " + String(response.status) + (response.statusText ? " " + String(response.statusText) : ""),
              ));
              return;
            }
            var read;
            try {
              read = response.text();
            } catch (error) {
              reject(makeFailure("parse", "error.parse", describeThrown(error)));
              return;
            }
            Promise.resolve(read).then(
              function (text) {
                var data;
                try {
                  data = JSON.parse(String(text));
                } catch (error) {
                  reject(makeFailure("parse", "error.parse", "HTTP " + String(response.status) + " · " + previewText(text)));
                  return;
                }
                if (!data || typeof data !== "object" || Array.isArray(data)) {
                  reject(makeFailure("payload", "error.payload", t("error.adminShape")));
                  return;
                }
                if (data.ok !== true) {
                  // A missing admin credential is a capability this machine does not
                  // have, not a failure to report as one. The flag travels with the
                  // failure so the management view can say "unavailable" instead of
                  // drawing an error box for something the user cannot fix by retrying.
                  if (data.admin && data.admin.available === false) {
                    var missing = makeFailure("capability", "manage.credentialMissing", readServerReason(data));
                    missing.capabilityMissing = true;
                    reject(missing);
                    return;
                  }
                  reject(makeFailure("payload", "error.notOk", readServerReason(data)));
                  return;
                }
                resolve(data);
              },
              function (error) {
                reject(makeFailure("parse", "error.parse", describeThrown(error)));
              },
            );
          },
          function (error) {
            reject(makeFailure("network", "error.network", describeThrown(error)));
          },
        );
      });
    }

    function readServerReason(data) {
      var candidates = [data.error, data.reason, data.message];
      for (var index = 0; index < candidates.length; index += 1) {
        var value = candidates[index];
        if (typeof value === "string" && value !== "") return value;
        if (value && typeof value === "object") {
          var nested = stringOr(value.message, stringOr(value.code, ""));
          if (nested !== "") return nested;
        }
      }
      return t("error.notOk");
    }

    function normalizeEntry(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      var id = stringOr(value.id, "");
      if (id === "") return null;
      var scope = stringOr(value.scope, "");
      return {
        id: id,
        kind: stringOr(value.kind, ""),
        title: stringOr(value.title, id),
        status: stringOr(value.status, ""),
        scope: scope,
        source: stringOr(value.source, scope === "" ? "unknown" : scope),
        proposalState: stringOr(value.proposalState, ""),
        updatedAt: numberOrNull(value.updatedAt),
        excerpt: stringOr(value.excerpt, ""),
      };
    }

    /** One task row as `/amb/summary` reports it; an unusable row is dropped. */
    function normalizeTask(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      var id = stringOr(value.id, "");
      if (id === "") return null;
      return {
        id: id,
        title: stringOr(value.title, id),
        status: stringOr(value.status, ""),
        projectId: stringOr(value.projectId, ""),
        evidence: stringOr(value.evidence, ""),
        summary: stringOr(value.summary, ""),
        updatedAt: numberOrNull(value.updatedAt),
      };
    }

    /**
     * One category group as `/amb/summary` reports it.
     *
     * A group the host could not read keeps its identity and carries its own
     * reason: an empty list alone would be indistinguishable from "this category
     * is empty", which is exactly the difference the panel must not blur.
     */
    function normalizeFacet(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      var kind = stringOr(value.kind, "");
      if (kind === "") return null;
      return {
        kind: kind,
        labelKey: stringOr(value.labelKey, ""),
        guideKey: stringOr(value.guideKey, ""),
        total: numberOrNull(value.total),
        limit: numberOrNull(value.limit),
        error: stringOr(value.error, ""),
        entries: Array.isArray(value.entries)
          ? value.entries.map(normalizeEntry).filter(function (entry) { return entry !== null; })
          : [],
      };
    }

    /**
     * The candidate queue, as far as this credential can see it.
     *
     * `approved` and `archived` are unreadable on an adapter credential, so they
     * arrive null and the panel prints "not provided". `reviewAvailable` is the
     * host's own statement about whether the panel can act on a candidate, and it is
     * carried through rather than assumed.
     */
    function normalizeProposals(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return {
        pending: numberOrNull(value.pending),
        approved: numberOrNull(value.approved),
        archived: numberOrNull(value.archived),
        reviewAvailable: value.reviewAvailable === true,
      };
    }

    function normalizeSummary(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw makeFailure("payload", "error.payload", t("error.summaryShape") + "：响应不是 JSON 对象");
      }
      if (data.ok !== true) {
        throw makeFailure("payload", "error.notOk", readServerReason(data));
      }
      var core = data.core;
      if (!core || typeof core !== "object" || Array.isArray(core)) {
        throw makeFailure("payload", "error.payload", t("error.summaryShape") + "：缺少 core");
      }
      if (typeof core.reachable !== "boolean") {
        throw makeFailure("payload", "error.payload", t("error.summaryShape") + "：core.reachable 不是布尔值");
      }
      var counts = data.counts;
      if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
        throw makeFailure("payload", "error.payload", t("error.summaryShape") + "：缺少 counts");
      }
      var outbox = counts.outbox && typeof counts.outbox === "object" && !Array.isArray(counts.outbox)
        ? counts.outbox
        : null;
      return {
        reachable: core.reachable,
        endpoint: stringOr(core.endpoint, ""),
        projectId: stringOr(core.projectId, ""),
        coreReason: stringOr(core.reason, stringOr(core.detail, "")),
        revision: numberOrNull(data.revision),
        counts: {
          knowledge: numberOrNull(counts.knowledge),
          pendingProposals: numberOrNull(counts.pendingProposals),
          tasks: numberOrNull(counts.tasks),
          outboxPending: outbox ? numberOrNull(outbox.pending) : null,
          outboxFailed: outbox ? numberOrNull(outbox.failed) : null,
          outboxAbandoned: outbox ? numberOrNull(outbox.abandoned) : null,
        },
        // Absent grouping data degrades to null, not to an empty group list: the
        // panel then says the grouping was not provided instead of drawing five
        // empty categories and calling the library empty.
        facets: Array.isArray(data.facets)
          ? data.facets.map(normalizeFacet).filter(function (facet) { return facet !== null; })
          : null,
        tasks: Array.isArray(data.tasks)
          ? data.tasks.map(normalizeTask).filter(function (task) { return task !== null; })
          : null,
        proposals: normalizeProposals(data.proposals),
        knowledge: Array.isArray(data.knowledge)
          ? data.knowledge.map(normalizeEntry).filter(function (entry) { return entry !== null; })
          : null,
      };
    }

    function requestSummary(fetchImpl) {
      return requestJson(ENDPOINTS.summary, fetchImpl).then(normalizeSummary);
    }

    function requestSearch(query, limit, fetchImpl) {
      var path = ENDPOINTS.search + "?q=" + encodeURIComponent(query) + "&limit=" + String(limit);
      return requestJson(path, fetchImpl).then(function (data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw makeFailure("payload", "error.payload", t("error.searchShape") + "：响应不是 JSON 对象");
        }
        if (data.ok !== true) throw makeFailure("payload", "error.notOk", readServerReason(data));
        if (!Array.isArray(data.results)) {
          throw makeFailure("payload", "error.payload", t("error.searchShape") + "：缺少 results 数组");
        }
        return data.results.map(normalizeEntry).filter(function (entry) { return entry !== null; });
      });
    }

    function requestTask(taskId, fetchImpl) {
      var id = String(taskId === null || taskId === undefined ? "" : taskId).trim();
      if (id === "") return Promise.reject(makeFailure("payload", "error.payload", t("error.taskId")));
      var path = ENDPOINTS.task + "?taskId=" + encodeURIComponent(id);
      return requestJson(path, fetchImpl).then(function (data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw makeFailure("payload", "error.payload", t("error.taskShape") + "：响应不是 JSON 对象");
        }
        if (data.ok !== true) throw makeFailure("payload", "error.notOk", readServerReason(data));
        var task = data.task;
        if (task === null || task === undefined) return null;
        if (typeof task !== "object" || Array.isArray(task)) {
          throw makeFailure("payload", "error.payload", t("error.taskShape") + "：task 不是对象");
        }
        return {
          id: stringOr(task.id, id),
          title: stringOr(task.title, id),
          status: stringOr(task.status, ""),
          summary: stringOr(task.summary, stringOr(task.excerpt, "")),
          updatedAt: numberOrNull(task.updatedAt),
        };
      });
    }

    function formatTimestamp(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return t("entry.timeUnknown");
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return t("entry.timeUnknown");
      try {
        return date.toLocaleString();
      } catch (ignored) {
        return String(value);
      }
    }

    function formatCount(value) {
      return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
    }

    function toneForPositive(value, tone) {
      if (value === null) return "idle";
      return value > 0 ? tone : "success";
    }

    var STYLES = `
.amb-knowledge-panel {
  --amb-bg-base: var(--dsw-alias-bg-base, #ffffff);
  --amb-bg-layer-1: var(--dsw-alias-bg-layer-1, #f6f7f9);
  --amb-bg-layer-2: var(--dsw-alias-bg-layer-2, #eceef2);
  --amb-bg-overlay: var(--dsw-alias-bg-overlay, rgba(16, 20, 26, 0.08));
  --amb-border-l1: var(--dsw-alias-border-l1, rgba(16, 20, 26, 0.10));
  --amb-border-l2: var(--dsw-alias-border-l2, rgba(16, 20, 26, 0.18));
  --amb-brand: var(--dsw-alias-brand-primary, #2c6ff0);
  --amb-label-primary: var(--dsw-alias-label-primary, #14181f);
  --amb-label-secondary: var(--dsw-alias-label-secondary, #5c6672);
  --amb-state-error: var(--dsw-alias-state-error-primary, #d92d20);
  --amb-state-idle: var(--dsw-alias-state-idle-primary, #98a2b3);
  --amb-state-success: var(--dsw-alias-state-success-primary, #0f9d58);
  --amb-state-warn: var(--dsw-alias-state-warn-primary, #e08700);
  --amb-sidebar-fill: var(--dsw-specific-sidebar-fill, #f2f4f7);
  /* Category identity. Every value is a host semantic token with an inline
     fallback, so switching the harness theme repaints the badges too. */
  --amb-kind-skill: var(--dsw-alias-brand-primary, #2c6ff0);
  --amb-kind-journal: var(--dsw-alias-label-secondary, #5c6672);
  --amb-kind-material: var(--dsw-alias-state-warn-primary, #e08700);
  --amb-kind-memory: var(--dsw-alias-state-success-primary, #0f9d58);
  --amb-kind-norm: var(--dsw-alias-label-primary, #14181f);
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 20px;
  background: var(--amb-bg-base);
  color: var(--amb-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
@media (prefers-color-scheme: dark) {
  .amb-knowledge-panel {
    --amb-bg-base: var(--dsw-alias-bg-base, #14171d);
    --amb-bg-layer-1: var(--dsw-alias-bg-layer-1, #1a1e26);
    --amb-bg-layer-2: var(--dsw-alias-bg-layer-2, #222732);
    --amb-bg-overlay: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.10));
    --amb-border-l1: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));
    --amb-border-l2: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.20));
    --amb-brand: var(--dsw-alias-brand-primary, #6d9bff);
    --amb-label-primary: var(--dsw-alias-label-primary, #e8ebf0);
    --amb-label-secondary: var(--dsw-alias-label-secondary, #9aa4b2);
    --amb-state-error: var(--dsw-alias-state-error-primary, #ff6b6b);
    --amb-state-idle: var(--dsw-alias-state-idle-primary, #6b7280);
    --amb-state-success: var(--dsw-alias-state-success-primary, #35c46f);
    --amb-state-warn: var(--dsw-alias-state-warn-primary, #f0a52b);
    --amb-sidebar-fill: var(--dsw-specific-sidebar-fill, #1a1e26);
    --amb-kind-skill: var(--dsw-alias-brand-primary, #6d9bff);
    --amb-kind-journal: var(--dsw-alias-label-secondary, #9aa4b2);
    --amb-kind-material: var(--dsw-alias-state-warn-primary, #f0a52b);
    --amb-kind-memory: var(--dsw-alias-state-success-primary, #35c46f);
    --amb-kind-norm: var(--dsw-alias-label-primary, #e8ebf0);
  }
}
.amb-statusbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-sidebar-fill);
}
.amb-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--amb-state-idle);
}
.amb-dot[data-state="success"] { background: var(--amb-state-success); }
.amb-dot[data-state="warn"] { background: var(--amb-state-warn); }
.amb-dot[data-state="error"] { background: var(--amb-state-error); }
.amb-status-title { font-weight: 600; }
.amb-meta { color: var(--amb-label-secondary); }
.amb-warn-text { color: var(--amb-state-warn); }
.amb-error-text { color: var(--amb-state-error); }
.amb-spacer { flex: 1 1 auto; }
.amb-button {
  border: 1px solid var(--amb-border-l2);
  border-radius: 6px;
  padding: 4px 12px;
  background: var(--amb-bg-layer-2);
  color: var(--amb-label-primary);
  font: inherit;
  cursor: pointer;
}
.amb-button:hover:enabled { background: var(--amb-bg-overlay); }
.amb-button:disabled { opacity: 0.6; cursor: default; }
.amb-section { display: flex; flex-direction: column; gap: 6px; }
.amb-section-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--amb-label-secondary); }
.amb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
}
.amb-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-bg-layer-1);
}
.amb-card-label { color: var(--amb-label-secondary); font-size: 12px; }
.amb-card-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.amb-card-value[data-tone="success"] { color: var(--amb-state-success); }
.amb-card-value[data-tone="warn"] { color: var(--amb-state-warn); }
.amb-card-value[data-tone="error"] { color: var(--amb-state-error); }
.amb-card-value[data-tone="idle"] { color: var(--amb-state-idle); }
.amb-searchbar { display: flex; align-items: center; gap: 8px; }
.amb-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 10px;
  border: 1px solid var(--amb-border-l2);
  border-radius: 6px;
  background: var(--amb-bg-base);
  color: var(--amb-label-primary);
  font: inherit;
}
.amb-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.amb-row {
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-bg-layer-1);
  overflow: hidden;
}
.amb-row-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.amb-row-button:hover { background: var(--amb-bg-overlay); }
.amb-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.amb-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--amb-border-l2);
  border-radius: 4px;
  background: var(--amb-bg-layer-2);
  color: var(--amb-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.amb-badge[data-kind="task"] { border-color: var(--amb-brand); color: var(--amb-brand); }
/* Category tint. One rule per category, all painting from the panel's own
   semantic aliases, so no badge carries a literal colour of its own. */
.amb-badge[data-tone="skill"] { border-color: var(--amb-kind-skill); color: var(--amb-kind-skill); }
.amb-badge[data-tone="journal"] { border-color: var(--amb-kind-journal); color: var(--amb-kind-journal); }
.amb-badge[data-tone="material"] { border-color: var(--amb-kind-material); color: var(--amb-kind-material); }
.amb-badge[data-tone="memory"] { border-color: var(--amb-kind-memory); color: var(--amb-kind-memory); }
.amb-badge[data-tone="norm"] { border-color: var(--amb-kind-norm); color: var(--amb-kind-norm); }
.amb-badge[data-tone="project"] { border-color: var(--amb-brand); color: var(--amb-brand); }
.amb-badge[data-tone="global"] { border-color: var(--amb-border-l2); color: var(--amb-label-primary); }
.amb-badge[data-tone="session"] { border-color: var(--amb-state-idle); color: var(--amb-label-secondary); }
.amb-badge[data-tone="proposal"] { border-color: var(--amb-state-warn); color: var(--amb-state-warn); }
/* Lifecycle. The state word is printed as well as coloured, so the badge still
   reads correctly when a theme maps two states to similar hues. */
.amb-badge[data-state="active"] { border-color: var(--amb-state-success); color: var(--amb-state-success); }
.amb-badge[data-state="archived"] { border-color: var(--amb-state-idle); color: var(--amb-label-secondary); }
.amb-badge[data-state="retired"] { border-color: var(--amb-state-error); color: var(--amb-state-error); }
.amb-badge[data-state="missing"] { border-style: dashed; color: var(--amb-state-idle); }
.amb-badge[data-state="pending"] { border-color: var(--amb-state-warn); color: var(--amb-state-warn); }
.amb-badge[data-state="approved"] { border-color: var(--amb-state-success); color: var(--amb-state-success); }
.amb-badge[data-state="empty"] { color: var(--amb-state-idle); }
.amb-viewnav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-bg-layer-1);
}
.amb-viewnav-label { color: var(--amb-label-secondary); font-size: 12px; }
.amb-tab {
  border: 1px solid var(--amb-border-l2);
  border-radius: 6px;
  padding: 3px 10px;
  background: var(--amb-bg-layer-1);
  color: var(--amb-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.amb-tab:hover { background: var(--amb-bg-overlay); }
.amb-tab[aria-pressed="true"] {
  border-color: var(--amb-brand);
  background: var(--amb-bg-layer-2);
  color: var(--amb-brand);
  font-weight: 600;
}
.amb-guide-line { color: var(--amb-label-secondary); font-size: 12px; }
.amb-scope-line { color: var(--amb-label-secondary); font-size: 12px; }
.amb-group {
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-bg-layer-1);
}
.amb-group + .amb-group { margin-top: 6px; }
/* The management view's blocks. They reuse the group card's vocabulary so a
   management section reads as the same kind of thing as a category group; only
   the block title, the field label and the manifest preview need rules of their
   own. Colours come from the same variables as everything else, so a theme
   switch moves them with the rest of the panel. */
.amb-block {
  border: 1px solid var(--amb-border-l1);
  border-radius: 8px;
  background: var(--amb-bg-layer-1);
  padding: 10px 12px;
  margin-top: 8px;
}
.amb-block-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--amb-label-primary);
}
.amb-field-label {
  display: block;
  margin: 8px 0 4px;
  font-size: 12px;
  color: var(--amb-label-secondary);
}
/* The inspect manifest: monospaced, scrollable, and never wider than the panel. */
/* The review list. Each candidate is identified by its own text, so the text is the
   control that opens the rest: a reviewer cannot judge what they cannot read, and
   expanding every row by default would make the list unscannable. */
.amb-proposal-head {
  align-items: baseline;
  gap: 8px;
}

.amb-proposal-summary {
  flex: 1 1 auto;
  text-align: left;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: var(--amb-label-primary);
  overflow-wrap: anywhere;
}

.amb-proposal-summary:hover {
  color: var(--amb-brand);
}

.amb-proposal-body {
  margin: 8px 0 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 6px;
  background: var(--amb-bg-layer-1);
  border: 1px solid var(--amb-border-l1);
  color: var(--amb-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
}

.amb-actions {
  margin-top: 8px;
  gap: 8px;
}

/* Weight, the way the rest of the host reads it: the action you mean is filled, the
   others are outlined, and archiving - which removes something from the queue - carries
   the danger colour. */
.amb-button.amb-primary {
  background: var(--amb-brand);
  border-color: var(--amb-brand);
  /* The base surface colour reads as the "on-brand" foreground in either theme, and it
     keeps this file free of a literal colour outside a token fallback. */
  color: var(--amb-bg-base);
}

.amb-button.amb-danger {
  color: var(--amb-state-error);
  border-color: var(--amb-state-error);
}

.amb-inspect {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  border-radius: 6px;
  background: var(--amb-bg-layer-2);
  color: var(--amb-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.amb-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  list-style: none;
}
.amb-group-head::-webkit-details-marker { display: none; }
.amb-group-title { font-weight: 600; }
.amb-group-guide {
  display: block;
  padding: 0 12px 4px;
  color: var(--amb-label-secondary);
  font-size: 12px;
}
.amb-group-body { padding: 4px 12px 10px; }
.amb-taskgroup { margin-top: 6px; }
.amb-row-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amb-row-meta { flex: 0 0 auto; color: var(--amb-label-secondary); font-size: 12px; }
.amb-detail {
  padding: 8px 12px;
  border-top: 1px solid var(--amb-border-l1);
  color: var(--amb-label-secondary);
}
.amb-detail-line { display: block; }
.amb-detail-code {
  display: block;
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.amb-state {
  padding: 12px;
  border: 1px dashed var(--amb-border-l2);
  border-radius: 8px;
  color: var(--amb-label-secondary);
  text-align: center;
}
.amb-state-error { border-style: solid; border-color: var(--amb-state-error); color: var(--amb-state-error); }
.amb-error-title { font-weight: 600; }
.amb-retry { margin-top: 8px; }
`;

    function resolveDocument() {
      if (typeof document !== "undefined" && document && document.head) return document;
      if (typeof window !== "undefined" && window && window.document && window.document.head) {
        return window.document;
      }
      return null;
    }

    /**
     * Install the panel stylesheet once and return its disposer.
     *
     * The tag carries `data-plugin`/`data-plugin-css` so it is identifiable and
     * removable; the returned function detaches it, and `apply` hands that
     * function to `ctx.effect` so plugin unload removes it as well.
     */
    function installStyles() {
      var doc = resolveDocument();
      if (!doc || !doc.head || typeof doc.createElement !== "function") return function () {};
      var selector = 'style[data-plugin-css="' + STYLE_TAG_ID + '"]';
      if (typeof doc.querySelector === "function" && doc.querySelector(selector)) return function () {};
      var tag = doc.createElement("style");
      if (typeof tag.setAttribute === "function") {
        tag.setAttribute("data-plugin", PLUGIN_ID);
        tag.setAttribute("data-plugin-css", STYLE_TAG_ID);
      }
      tag.textContent = STYLES;
      doc.head.appendChild(tag);
      return function () {
        if (tag.parentNode && typeof tag.parentNode.removeChild === "function") {
          tag.parentNode.removeChild(tag);
        }
      };
    }

    function statusBar(h, options) {
      var summary = options.summary;
      var dotState = "idle";
      var titleKey = "status.checking";
      var reason = "";
      if (options.phase === "error") {
        dotState = "error";
        titleKey = "status.unavailable";
        reason = failureText(options.failure);
      } else if (options.phase === "ready" && summary) {
        dotState = summary.reachable ? "success" : "error";
        titleKey = summary.reachable ? "status.reachable" : "status.unreachable";
        reason = summary.reachable ? "" : stringOr(summary.coreReason, t("status.unreachableReason"));
      }
      return h("div", { className: "amb-statusbar" },
        h("span", { className: "amb-dot", "data-state": dotState, "aria-hidden": "true" }),
        h("span", { className: "amb-status-title" }, t(titleKey)),
        h("span", { className: "amb-meta" },
          t("status.project") + "：" + (summary && summary.projectId ? summary.projectId : t("status.unknown"))),
        h("span", { className: "amb-meta" },
          t("status.revision") + "：" + (summary && summary.revision !== null ? String(summary.revision) : t("status.unknown"))),
        h("span", { className: "amb-spacer" }),
        reason ? h("span", { className: "amb-meta amb-error-text" }, reason) : null,
        h("button", {
          type: "button",
          className: "amb-button",
          onClick: options.onRefresh,
          disabled: options.phase === "loading",
        }, options.phase === "loading" ? t("action.refreshing") : t("action.refresh")),
      );
    }

    function countCard(h, label, value, tone) {
      return h("div", { className: "amb-card", "data-tone": tone },
        h("span", { className: "amb-card-label" }, label),
        h("span", { className: "amb-card-value", "data-tone": tone }, formatCount(value)),
      );
    }

    function overviewSection(h, summary) {
      var counts = summary.counts;
      var incomplete = counts.knowledge === null
        || counts.pendingProposals === null
        || counts.outboxPending === null
        || counts.outboxFailed === null
        || counts.outboxAbandoned === null;
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("section.overview")),
        h("div", { className: "amb-grid" },
          countCard(h, t("count.knowledge"), counts.knowledge, "normal"),
          countCard(h, t("count.pendingProposals"), counts.pendingProposals,
            counts.pendingProposals === null ? "idle" : counts.pendingProposals > 0 ? "warn" : "success"),
          countCard(h, t("queue.pending"), counts.outboxPending,
            counts.outboxPending === null ? "idle" : counts.outboxPending > 0 ? "warn" : "success"),
          countCard(h, t("queue.failed"), counts.outboxFailed, toneForPositive(counts.outboxFailed, "error")),
          countCard(h, t("queue.abandoned"), counts.outboxAbandoned, toneForPositive(counts.outboxAbandoned, "warn")),
        ),
        incomplete ? h("div", { className: "amb-meta amb-warn-text" }, t("state.fieldWarning")) : null,
      );
    }

    /** The copy key for a knowledge entry's state, or null when unnamed. */
    function entryStatusKey(status) {
      return Object.prototype.hasOwnProperty.call(ENTRY_STATUS_KEYS, status) ? ENTRY_STATUS_KEYS[status] : null;
    }

    /** Blueprint tone for a lifecycle state; an unnamed state is neutral. */
    function entryStatusTone(status) {
      if (status === "") return "missing";
      if (status === "active") return "active";
      if (status === "archived") return "archived";
      if (status === "retired") return "retired";
      return "unknown";
    }

    /** The label of a knowledge category, from the category table. */
    function kindLabel(kind) {
      for (var index = 0; index < KIND_GUIDE_KEYS.length; index += 1) {
        if (KIND_GUIDE_KEYS[index].kind === kind) return t(KIND_GUIDE_KEYS[index].labelKey);
      }
      return kind === "" ? t("kind.unknown") : kind;
    }

    /** The one-line purpose statement that heads a category group. */
    function kindGuide(kind) {
      for (var index = 0; index < KIND_GUIDE_KEYS.length; index += 1) {
        if (KIND_GUIDE_KEYS[index].kind === kind) return t(KIND_GUIDE_KEYS[index].guideKey);
      }
      return "";
    }

    /** The label of a task state, falling back to the raw value the core reported. */
    function taskStatusLabel(status) {
      if (status === "") return t("badge.unknown");
      for (var index = 0; index < TASK_STATUS_KEYS.length; index += 1) {
        if (TASK_STATUS_KEYS[index].status === status) return t(TASK_STATUS_KEYS[index].labelKey);
      }
      return status;
    }

    /** Tone for a task group header: a live task warns, a closed one is neutral. */
    function taskStatusTone(status) {
      if (status === "in_progress" || status === "paused") return "pending";
      if (status === "completed") return "approved";
      if (status === "failed" || status === "cancelled") return "retired";
      return "archived";
    }

    function badge(h, tone, state, text, key) {
      return h("span", {
        className: "amb-badge",
        "data-tone": tone,
        "data-state": state,
        key: key,
      }, text);
    }

    /**
     * The category badge. A category the core reports but this table does not name
     * still prints, under its raw value, in the neutral tone: hiding it would make
     * an entry disappear from the navigation it belongs to.
     */
    function kindBadge(h, kind, key) {
      return badge(h, kind, null, kindLabel(kind), key);
    }

    /**
     * The lifecycle badge.
     *
     * The state word is always printed. An entry with no state at all prints the
     * explicit "not provided" marker in the dashed missing tone rather than
     * "active", because that is the one claim the panel cannot make on its behalf.
     */
    function entryStatusBadge(h, entry, key) {
      var tone = entryStatusTone(entry.status);
      var text = entry.status === ""
        ? t("badge.unknown")
        : (entryStatusKey(entry.status) !== null ? t(entryStatusKey(entry.status)) : entry.status);
      return badge(h, "state", tone, text, key);
    }

    /**
     * The origin badge.
     *
     * `global` means the entry applies to every project - the normal case, since
     * `knowledge` has no project column. `project` and `session` mean the reader's
     * own scope. An entry that came in through a candidate is marked as such with
     * the candidate's state, when the host could read it.
     */
    function sourceBadge(h, item, key) {
      if (stringOr(item.proposalState, "") !== "") {
        return badge(h, "proposal", "pending", t("entry.source.proposal"), key);
      }
      var source = stringOr(item.source, "unknown");
      if (source === "global") return badge(h, "global", null, t("entry.source.global"), key);
      if (source === "project") return badge(h, "project", null, t("entry.source.project"), key);
      if (source === "session") return badge(h, "session", null, t("entry.source.session"), key);
      return badge(h, "state", "empty", t("entry.source.unknown"), key);
    }

    /**
     * The three badges every entry carries: category, lifecycle, origin. The
     * category badge is optional only where the surrounding group header already
     * states it, so no row is ever left without a category marker in view.
     */
    function entryBadges(h, item, options) {
      var withKind = !options || options.withKind !== false;
      return [
        withKind ? kindBadge(h, item.kind, item.id + "-kind") : null,
        entryStatusBadge(h, item, item.id + "-status"),
        sourceBadge(h, item, item.id + "-source"),
      ];
    }

    function entryRow(h, entry, expanded, onToggle, options) {
      var isOpen = expanded !== null && expanded.id === entry.id;
      // The detail pane stays inside its own list item: a bare block between
      // `<li>` elements would be invalid list content.
      return h("li", { className: "amb-row", key: entry.id },
        h("button", {
          type: "button",
          className: "amb-row-button",
          onClick: function () { onToggle(entry); },
          "aria-expanded": isOpen,
          title: t("entry.expandHint"),
        },
          entryBadges(h, entry, options),
          h("span", { className: "amb-row-title" }, entry.title),
          entry.scope ? h("span", { className: "amb-row-meta" }, t("entry.scope") + "：" + entry.scope) : null,
          h("span", { className: "amb-row-meta" }, formatTimestamp(entry.updatedAt)),
        ),
        isOpen ? entryDetail(h, expanded) : null,
      );
    }

    function entryDetail(h, expanded) {
      if (expanded.phase === "loading") {
        return h("div", { className: "amb-detail", key: expanded.id + "-detail" }, t("entry.taskLoading"));
      }
      if (expanded.phase === "error") {
        return h("div", { className: "amb-detail amb-error-text", key: expanded.id + "-detail" },
          t(expanded.failure ? expanded.failure.messageKey : "error.unknown"),
          expanded.failure && expanded.failure.detail
            ? h("span", { className: "amb-detail-code" }, expanded.failure.detail)
            : null,
        );
      }
      if (expanded.phase === "missing") {
        return h("div", { className: "amb-detail", key: expanded.id + "-detail" }, t("entry.taskMissing"));
      }
      if (expanded.task) {
        return h("div", { className: "amb-detail", key: expanded.id + "-detail" },
          h("span", { className: "amb-detail-line" },
            t("entry.taskStatus") + "：" + (expanded.task.status === "" ? t("kind.unknown") : expanded.task.status)),
          expanded.task.summary
            ? h("span", { className: "amb-detail-line" }, t("entry.taskSummary") + "：" + expanded.task.summary)
            : null,
          h("span", { className: "amb-detail-line" },
            t("entry.updated") + "：" + formatTimestamp(expanded.task.updatedAt)),
        );
      }
      return entryDetailFields(h, expanded);
    }

    /**
     * The detail of a knowledge entry.
     *
     * Only fields the entry actually carries are spelled out; a field the core did
     * not return is printed as "not provided" instead of being left out, so the
     * absence is visible rather than mistaken for an empty value.
     */
    function entryDetailFields(h, expanded) {
      var entry = expanded.entry;
      var lines = [];
      lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-kind" },
        t("badge.kind") + "：" + kindLabel(entry.kind)));
      lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-status" },
        t("badge.status") + "：" + (entry.status === "" ? t("entry.statusMissing") : entry.status)));
      lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-source" },
        t("badge.source") + "：" + t("entry.source." + stringOr(entry.source, "unknown"))));
      lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-proposal" },
        t("review.origin") + "：" + (stringOr(entry.proposalState, "") === ""
          ? t("entry.proposalStateMissing")
          : entry.proposalState)));
      lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-updated" },
        t("entry.updated") + "：" + formatTimestamp(entry.updatedAt)));
      if (entry.excerpt) lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-excerpt" }, entry.excerpt));
      if (expanded.phase === "empty") {
        lines.push(h("span", { className: "amb-detail-line", key: expanded.id + "-d-note" }, t("entry.excerptMissing")));
      }
      return h("div", { className: "amb-detail", key: expanded.id + "-detail" }, lines);
    }

    /** One task row: its own project id, its state, and the core's evidence level. */
    function taskRow(h, task) {
      return h("li", { className: "amb-row", key: "task-" + task.id },
        h("div", { className: "amb-row-head" },
          badge(h, "project", null,
            t("badge.project") + "：" + (task.projectId === "" ? t("tasks.projectMissing") : task.projectId),
            task.id + "-project"),
          badge(h, "state", taskStatusTone(task.status), taskStatusLabel(task.status), task.id + "-state"),
          h("span", { className: "amb-row-title" }, task.title),
          h("span", { className: "amb-row-meta" }, formatTimestamp(task.updatedAt)),
        ),
        task.summary ? h("div", { className: "amb-detail" }, task.summary) : null,
        task.evidence
          ? h("div", { className: "amb-detail-line amb-meta" }, t("tasks.evidence") + "：" + task.evidence)
          : null,
      );
    }

    /**
     * One candidate row.
     *
     * The panel can read the pending total but not the queue itself (`/v1/proposals/list`
     * is admin-only), so the row states what the count means and where a decision is
     * taken. It carries no accept or reject control, because the panel has none.
     */
    function proposalRow(h) {
      return h("li", { className: "amb-row", key: "pending-proposals" },
        h("div", { className: "amb-row-head" },
          badge(h, "state", "pending", t("review.pending"), "pending-state"),
          h("span", { className: "amb-row-title" }, t("review.origin") + "：" + t("review.originValue")),
        ),
        h("div", { className: "amb-detail-line amb-meta" }, t("review.onlyDisplay")),
      );
    }

    function listOf(h, items, renderItem) {
      var rows = [];
      for (var index = 0; index < items.length; index += 1) {
        rows.push(renderItem(items[index]));
      }
      return h("ul", { className: "amb-list" }, rows);
    }

    /** The flat view: every entry the credential can see, in one list. */
    function knowledgeSection(h, options) {
      var body;
      if (options.phase === "loading") {
        body = stateBlock(h, t("state.loading"));
      } else if (options.phase === "error") {
        body = failureBlock(h, options.failure, options.onRetry);
      } else if (!options.summary) {
        body = stateBlock(h, t("state.noData"));
      } else if (options.summary.knowledge === null || options.summary.knowledge.length === 0) {
        body = stateBlock(h, t("state.emptyAll"));
      } else {
        body = listOf(h, options.summary.knowledge, function (entry) {
          return entryRow(h, entry, options.expanded, options.onToggle, null);
        });
      }
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("section.knowledge")),
        body,
      );
    }

    /** One collapsible category group, headed by its name, purpose and size. */
    function kindGroup(h, facet, options) {
      var head = h("summary", { className: "amb-group-head", key: facet.kind + "-head" },
        kindBadge(h, facet.kind, facet.kind + "-badge"),
        h("span", { className: "amb-group-title" }, kindLabel(facet.kind)),
        h("span", { className: "amb-row-meta" },
          facet.total === null ? t("entry.noFields") : String(facet.total) + " " + t("group.count")),
        h("span", { className: "amb-row-meta" }, t("badge.limit") + "：" + formatCount(facet.limit)),
      );
      var guide = h("span", { className: "amb-group-guide", key: facet.kind + "-guide" }, kindGuide(facet.kind));
      var body;
      if (facet.error !== "") {
        body = h("div", { className: "amb-state amb-state-error", key: facet.kind + "-error" },
          t("state.kindFailed"),
          h("span", { className: "amb-detail-code" }, t("error.detail") + "：" + facet.error),
        );
      } else if (facet.entries.length === 0) {
        body = h("div", { className: "amb-state", key: facet.kind + "-empty" }, t("state.emptyKind"));
      } else {
        body = listOf(h, facet.entries, function (entry) {
          return entryRow(h, entry, options.expanded, options.onToggle, { withKind: false });
        });
      }
      return h("details", { className: "amb-group", key: facet.kind, open: true },
        head,
        guide,
        h("div", { className: "amb-group-body", key: facet.kind + "-body" }, body),
      );
    }

    /**
     * The category view.
     *
     * Groups come from the host's own category page, so a group's size is the size
     * the core reported for that category, never a number inferred from one mixed
     * page. A response without grouping data says so and falls back to the flat
     * list rather than drawing categories that were never read.
     */
    function knowledgeGroupsSection(h, options) {
      var body;
      if (options.phase === "loading") {
        body = stateBlock(h, t("state.loading"));
      } else if (options.phase === "error") {
        body = failureBlock(h, options.failure, options.onRetry);
      } else if (!options.summary) {
        body = stateBlock(h, t("state.noData"));
      } else if (options.summary.facets === null) {
        body = h("div", { className: "amb-section" },
          stateBlock(h, t("state.facetsMissing")),
          options.summary.knowledge === null
            ? null
            : listOf(h, options.summary.knowledge, function (entry) {
              return entryRow(h, entry, options.expanded, options.onToggle, null);
            }),
        );
      } else {
        var groups = [];
        for (var index = 0; index < options.summary.facets.length; index += 1) {
          groups.push(kindGroup(h, options.summary.facets[index], options));
        }
        body = h("div", { className: "amb-section" }, groups);
      }
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("section.knowledge")),
        h("p", { className: "amb-guide-line" }, t("scope.notice")),
        body,
      );
    }

    /**
     * The review view.
     *
     * Reading the candidate queue is an admin power, so this panel can report the
     * pending count - which `/v1/stats` publishes - and nothing else about it. The
     * two unreadable states are printed as "not provided" with the reason, and the
     * section states plainly that a decision is taken on the DSH/CLI side.
     */
    function reviewSection(h, options) {
      var summary = options.summary;
      var proposals = summary.proposals;
      var body;
      if (options.phase === "loading") {
        body = stateBlock(h, t("state.loading"));
      } else if (options.phase === "error") {
        body = failureBlock(h, options.failure, options.onRetry);
      } else if (!summary) {
        body = stateBlock(h, t("state.noData"));
      } else if (proposals === null || proposals.pending === null) {
        body = stateBlock(h, t("review.unavailable"));
      } else {
        body = h("div", { className: "amb-section" },
          h("div", { className: "amb-grid" },
            countCard(h, t("review.pending"), proposals.pending,
              proposals.pending > 0 ? "warn" : "success"),
            countCard(h, t("review.approved"), proposals.approved, "idle"),
            countCard(h, t("review.archived"), proposals.archived, "idle"),
          ),
          h("p", { className: "amb-guide-line" }, t("review.readableNote")),
          h("p", { className: "amb-guide-line" }, t("review.onlyDisplay")),
          proposals.pending > 0
            ? h("ul", { className: "amb-list" }, proposalRow(h))
            : stateBlock(h, t("review.empty")),
        );
      }
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("review.title")),
        body,
      );
    }

    /**
     * The management view.
     *
     * Every action here needs the admin credential, and the page never holds it: the
     * panel names an action and the host performs it. Two consequences show up in the
     * markup - a missing credential is reported as an *unavailable capability* rather
     * than as an error, and every action that changes the library asks before running.
     *
     * `confirm` is passed in rather than called directly so the confirmation is
     * testable: the panel's own test drives it without a real dialog.
     */
    function manageSection(h, options) {
      var admin = options.admin;
      var title = h("h3", { className: "amb-section-title" }, t("manage.title"));
      if (admin.available === false) {
        return h("section", { className: "amb-section" }, title,
          stateBlock(h, t("manage.credentialMissing")));
      }
      var busy = admin.busy !== "";
      var children = [title];
      if (admin.message) children.push(h("p", { className: "amb-guide-line" }, admin.message));
      if (admin.failure) children.push(failureBlock(h, admin.failure, options.onRetry));

      // Migration. Export reads the whole library in one call; import writes entries
      // straight into the effective library. Both are the human's, not an agent's.
      children.push(h("div", { className: "amb-block" },
        h("h4", { className: "amb-block-title" }, t("manage.backupTitle")),
        h("p", { className: "amb-guide-line" }, t("manage.backupNote")),
        h("div", { className: "amb-row" },
          h("button", {
            type: "button",
            className: "amb-button",
            disabled: busy,
            onClick: function () { options.onAction("backup-export", {}); },
          }, admin.busy === "backup-export" ? t("manage.exporting") : t("manage.export")),
        ),
        h("label", { className: "amb-field-label" }, t("manage.importPath")),
        h("div", { className: "amb-row" },
          h("input", {
            type: "text",
            className: "amb-input",
            value: options.importPath,
            onChange: function (event) { options.onImportPathChange(event.target.value); },
          }),
        ),
        h("div", { className: "amb-row" },
          h("button", {
            type: "button",
            className: "amb-button",
            disabled: busy,
            onClick: function () { options.onInspect(); },
          }, admin.busy === "backup-inspect" ? t("manage.inspecting") : t("manage.inspect")),
          h("button", {
            type: "button",
            className: "amb-button",
            disabled: busy || options.importPath === "",
            onClick: function () {
              if (!options.confirm || options.confirm(t("manage.confirm"))) {
                options.onAction("backup-import", { path: options.importPath });
              }
            },
          }, admin.busy === "backup-import" ? t("manage.importing") : t("manage.import")),
        ),
        options.inspectResult
          ? h("div", { className: "amb-block" },
            h("h4", { className: "amb-block-title" }, t("manage.inspectTitle")),
            h("pre", { className: "amb-inspect" }, options.inspectResult))
          : null,
      ));

      // Proposal review: what an agent may propose but not decide.
      children.push(h("div", { className: "amb-block" },
        h("h4", { className: "amb-block-title" }, t("manage.proposalsTitle")),
        h("p", { className: "amb-guide-line" }, t("manage.proposalsNote")),
      ));
      if (admin.phase === "loading") {
        children.push(stateBlock(h, t("manage.loading")));
      } else if (admin.proposals === null) {
        children.push(stateBlock(h, t("manage.unavailable")));
      } else if (admin.proposals.length === 0) {
        children.push(stateBlock(h, t("manage.empty")));
      } else {
        children.push(h("ul", { className: "amb-list" }, admin.proposals.map(function (proposal) {
          var editing = options.compose && options.compose.id === proposal.id;
          var decide = function (action, extra) {
            return function () {
              if (!options.confirm || options.confirm(t("manage.confirm"))) {
                options.onAction(action, Object.assign({ id: proposal.id }, extra || {}));
              }
            };
          };
          // A candidate carries text, not a title: naming it by its id would tell the
          // reviewer nothing. Show the text itself - first line as the handle, the whole
          // thing one click away - plus when it arrived and which task produced it.
          var fullText = proposalText(proposal);
          var firstLine = fullText.split("\n").map(function (line) { return line.trim(); })
            .filter(function (line) { return line !== ""; })[0] || t("manage.noContent");
          var open = options.expandedProposal === proposal.id;
          var meta = [
            t("manage.submittedAt") + "：" + relativeTime(proposal.createdAt, t),
            proposal.payload && proposal.payload.taskId ? t("manage.fromTask") + "：" + proposal.payload.taskId : "",
            fullText.length > firstLine.length ? fullText.length + " " + t("manage.chars") : "",
          ].filter(function (part) { return part !== ""; });

          var head = [
            h("div", { className: "amb-row amb-proposal-head" },
              h("span", { className: "amb-badge", "data-tone": "proposal" }, t("review.pending")),
              // The summary is the control that reveals the rest: a reviewer cannot decide
              // on text they cannot read, and the list would be unusable if every
              // candidate were expanded by default.
              h("button", {
                type: "button",
                className: "amb-proposal-summary",
                "aria-expanded": open,
                onClick: function () { options.onExpandProposal(open ? null : proposal.id); },
              }, firstLine),
            ),
            h("div", { className: "amb-detail-line amb-meta" }, meta.join("  ·  ")),
          ];
          if (open) {
            // Verbatim: the reviewer is approving *this* text, not a paraphrase of it.
            head.push(h("pre", { className: "amb-proposal-body" }, fullText));
          }
          var row = head.concat([
            h("div", { className: "amb-row amb-actions" },
              // Primary action first and filled; the two destructive-ish ones outlined,
              // with archiving in the danger colour - the reading a reviewer expects
              // from every other DSH surface.
              h("button", {
                type: "button",
                className: "amb-button amb-primary",
                disabled: busy,
                onClick: function () { options.onCompose(editing ? null : proposal); },
              }, editing ? t("manage.cancel") : t("manage.approve")),
              h("button", { type: "button", className: "amb-button", disabled: busy, onClick: decide("proposal-reject") }, t("manage.reject")),
              h("button", { type: "button", className: "amb-button amb-danger", disabled: busy, onClick: decide("proposal-archive") }, t("manage.archive")),
            ),
          ]);
          var body = row;
          if (editing) {
            var onInput = function (field) {
              return function (event) {
                var value = event && event.target ? event.target.value : "";
                options.onComposeUpdate(field, value);
              };
            };
            body = row.concat([
              h("div", { className: "amb-block" },
                h("label", { className: "amb-field-label" }, t("manage.composeKind")),
                h("div", { className: "amb-row" }, h("select", {
                  className: "amb-input",
                  value: options.compose.kind,
                  onChange: onInput("kind"),
                }, KIND_GUIDE_KEYS.map(function (entry) {
                  return h("option", { key: entry.kind, value: entry.kind }, t(entry.labelKey));
                }))),
                h("label", { className: "amb-field-label" }, t("manage.composeTitle")),
                h("div", { className: "amb-row" }, h("input", {
                  type: "text",
                  className: "amb-input",
                  value: options.compose.title,
                  onChange: onInput("title"),
                })),
                h("p", { className: "amb-guide-line" }, t("manage.composeNote")),
                h("div", { className: "amb-row" },
                  h("button", {
                    type: "button",
                    className: "amb-button",
                    disabled: busy || options.compose.title === "",
                    onClick: decide("proposal-approve", { entry: options.onComposeEntry(proposal) }),
                  }, t("manage.approveConfirmed")),
                ),
              ),
            ]);
          }
          return h("li", { className: "amb-row", key: proposal.id }, body);
        })));
      }
      return h("section", { className: "amb-section" }, children);
    }

    /**
     * The task view, grouped by the core's own `status`.
     *
     * A state the panel's own table does not name is still shown, under its raw
     * value, so a task never vanishes from the view because of a stale label list.
     */
    function taskSection(h, options) {
      var summary = options.summary;
      var grouped = null;
      if (summary && summary.tasks !== null) {
        grouped = {};
        for (var index = 0; index < summary.tasks.length; index += 1) {
          var task = summary.tasks[index];
          if (!Object.prototype.hasOwnProperty.call(grouped, task.status)) grouped[task.status] = [];
          grouped[task.status].push(task);
        }
      }
      var body;
      if (options.phase === "loading") {
        body = stateBlock(h, t("state.loading"));
      } else if (options.phase === "error") {
        body = failureBlock(h, options.failure, options.onRetry);
      } else if (!summary || grouped === null) {
        body = stateBlock(h, t("tasks.unavailable"));
      } else if (summary.tasks.length === 0) {
        body = stateBlock(h, t("tasks.empty"));
      } else {
        var groups = [];
        for (var known = 0; known < TASK_STATUS_KEYS.length; known += 1) {
          var status = TASK_STATUS_KEYS[known].status;
          if (!Object.prototype.hasOwnProperty.call(grouped, status)) continue;
          groups.push(taskGroup(h, status, grouped[status]));
        }
        var names = Object.keys(grouped);
        for (var extra = 0; extra < names.length; extra += 1) {
          var seen = false;
          for (var position = 0; position < TASK_STATUS_KEYS.length; position += 1) {
            if (TASK_STATUS_KEYS[position].status === names[extra]) seen = true;
          }
          if (!seen) groups.push(taskGroup(h, names[extra], grouped[names[extra]]));
        }
        body = groups.length === 0 ? stateBlock(h, t("tasks.empty")) : h("div", { className: "amb-section" }, groups);
      }
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("section.tasks")),
        h("p", { className: "amb-guide-line" }, t("tasks.countNote")),
        body,
      );
    }

    /** One collapsible task-state group. */
    function taskGroup(h, status, items) {
      return h("details", { className: "amb-group", key: "task-group-" + status, open: true },
        h("summary", { className: "amb-group-head", key: "task-group-" + status + "-head" },
          badge(h, "state", taskStatusTone(status), taskStatusLabel(status), "task-status-" + status),
          h("span", { className: "amb-group-title" }, taskStatusLabel(status)),
          h("span", { className: "amb-row-meta" }, String(items.length) + " " + t("group.count")),
        ),
        h("div", { className: "amb-group-body", key: "task-group-" + status + "-body" },
          listOf(h, items, function (task) { return taskRow(h, task); }),
        ),
      );
    }

    /**
     * The view navigation: one pressed-state button per view, each with the guide
     * line that says what the view is for. It is a row of toggles rather than a tab
     * list because the panel owns no tab key handling of its own, and `aria-pressed`
     * is what a screen reader needs to read the current view.
     */
    function viewButton(h, view, current, onViewChange) {
      return h("button", {
        type: "button",
        className: "amb-tab",
        key: "view-" + view,
        "data-view-key": view,
        "aria-pressed": current === view,
        onClick: function () { onViewChange(view); },
      }, t("view." + view));
    }

    function viewNav(h, options) {
      var buttons = [];
      for (var index = 0; index < VIEW_KEYS.length; index += 1) {
        buttons.push(viewButton(h, VIEW_KEYS[index], options.view, options.onViewChange));
      }
      return h("div", { className: "amb-section" },
        h("div", { className: "amb-viewnav" },
          h("span", { className: "amb-viewnav-label" }, t("view.nav")),
          buttons,
        ),
        h("p", { className: "amb-guide-line" }, t("view.guide." + options.view)),
      );
    }

    function searchSection(h, options) {
      var state = options.state;
      return h("section", { className: "amb-section" },
        h("h3", { className: "amb-section-title" }, t("section.search")),
        h("div", { className: "amb-searchbar" },
          h("input", {
            className: "amb-input",
            type: "search",
            value: options.query,
            placeholder: t("search.placeholder"),
            "aria-label": t("search.placeholder"),
            onChange: function (event) {
              options.onQueryChange(event && event.target ? event.target.value : "");
            },
            onKeyDown: function (event) {
              if (event && (event.key === "Enter" || event.keyCode === 13)) options.onSubmit();
            },
          }),
          h("button", {
            type: "button",
            className: "amb-button",
            onClick: options.onSubmit,
            disabled: state.phase === "loading",
          }, state.phase === "loading" ? t("search.pending") : t("action.search")),
        ),
        searchBody(h, state),
      );
    }

    function searchBody(h, state) {
      if (state.phase === "loading") return stateBlock(h, t("search.pending"));
      if (state.phase === "error") return failureBlock(h, state.failure, null);
      if (state.phase === "idle") return stateBlock(h, t("state.searchIdle"));
      if (state.results.length === 0) {
        return stateBlock(h, t("state.emptySearch") + " " + t("state.emptySearchHint"));
      }
      var rows = [];
      for (var index = 0; index < state.results.length; index += 1) {
        var entry = state.results[index];
        rows.push(h("li", { className: "amb-row", key: "result-" + entry.id },
          h("div", { className: "amb-row-head" },
            entryBadges(h, entry, null),
            h("span", { className: "amb-row-title" }, entry.title),
            entry.scope ? h("span", { className: "amb-row-meta" }, t("entry.scope") + "：" + entry.scope) : null,
          ),
          entry.excerpt ? h("div", { className: "amb-detail" }, entry.excerpt) : null,
        ));
      }
      return h("ul", { className: "amb-list" }, rows);
    }

    function stateBlock(h, text) {
      return h("div", { className: "amb-state" }, text);
    }

    function failureBlock(h, failure, onRetry) {
      var detail = failure && failure.detail ? failure.detail : "";
      return h("div", { className: "amb-state amb-state-error" },
        h("div", { className: "amb-error-title" }, t(failure ? failure.messageKey : "error.unknown")),
        detail ? h("div", { className: "amb-detail-code" }, t("error.detail") + "：" + detail) : null,
        onRetry
          ? h("button", { type: "button", className: "amb-button amb-retry", onClick: onRetry }, t("action.retry"))
          : null,
      );
    }

    function failureText(failure) {
      if (!failure) return "";
      return failure.detail ? t(failure.messageKey) + "（" + failure.detail + "）" : t(failure.messageKey);
    }

    /**
     * The panel component.
     *
     * Hooks are declared unconditionally in a fixed order, and the returned tree
     * is built inside a guard: a render-time fault reports itself in the panel
     * instead of collapsing the whole slot entry.
     */
    function KnowledgePanel() {
      var h = React.createElement;
      // One hook call per slot, in a fixed order: a slot must never be declared
      // conditionally, and two calls to one useState are two different slots.
      var [reloadToken, setReloadToken] = React.useState(0);
      var [summaryState, setSummaryState] = React.useState({ phase: "loading", value: null, failure: null });
      var [query, setQuery] = React.useState("");
      var [searchState, setSearchState] = React.useState({ phase: "idle", query: "", results: [], failure: null });
      var [expanded, setExpanded] = React.useState(null);
      // One slot per value, declared in the same order every render: the view the
      // reader is looking at, from the panel's own navigation row.
      var [view, setView] = React.useState(VIEW_KEYS[0]);
      var searchSeq = React.useRef(0);
      /**
       * The management view's own state.
       *
       * `available` is deliberately three-valued: `null` means nothing has asked the
       * host yet, `false` means this machine has no admin credential (a capability the
       * panel reports as unavailable rather than as a failure), and `true` means the
       * calls are permitted. Folding "not asked yet" into "not available" would make a
       * freshly opened panel look broken before it had tried anything.
       */
      var [adminState, setAdminState] = React.useState({
        phase: "idle",
        available: null,
        proposals: null,
        busy: "",
        message: "",
        failure: null,
      });
      // The path typed into the import field, and the manifest the inspect call
      // returned. Kept apart from `adminState` because they survive an action's
      // result: after a failed import the path the user typed is still there.
      var [importPath, setImportPath] = React.useState("");
      var [inspectResult, setInspectResult] = React.useState("");
      /**
       * Which candidate is being turned into a knowledge entry, and how.
       *
       * Approving a candidate is not a one-click action: the candidate carries text,
       * while the core's approve verb wants a full entry, so the reviewer has to say
       * what the text should become. Holding that answer here (rather than defaulting
       * it) is what keeps the panel from writing an entry nobody chose.
       */
      var [compose, setCompose] = React.useState(null);
      // Which candidate's full text is open. Kept here rather than inside the row so only
      // one is open at a time - a review list where several are expanded at once is hard
      // to scan.
      var [expandedProposal, setExpandedProposal] = React.useState(null);

      React.useEffect(function () {
        var cancelled = false;
        setSummaryState({ phase: "loading", value: null, failure: null });
        requestSummary(resolveFetch()).then(
          function (value) {
            if (cancelled) return;
            setSummaryState({ phase: "ready", value: value, failure: null });
          },
          function (failure) {
            if (cancelled) return;
            setSummaryState({ phase: "error", value: null, failure: toFailure(failure) });
          },
        );
        return function () { cancelled = true; };
      }, [reloadToken]);

      var refresh = function () { setReloadToken(reloadToken + 1); };

      var submitSearch = function () {
        var trimmed = String(query).trim();
        if (trimmed === "") {
          setSearchState({ phase: "idle", query: "", results: [], failure: null });
          return;
        }
        searchSeq.current += 1;
        var seq = searchSeq.current;
        setSearchState({ phase: "loading", query: trimmed, results: [], failure: null });
        requestSearch(trimmed, SEARCH_LIMIT, resolveFetch()).then(
          function (results) {
            if (searchSeq.current !== seq) return;
            setSearchState({ phase: "ready", query: trimmed, results: results, failure: null });
          },
          function (failure) {
            if (searchSeq.current !== seq) return;
            setSearchState({ phase: "error", query: trimmed, results: [], failure: toFailure(failure) });
          },
        );
      };

      var toggleEntry = function (entry) {
        if (expanded !== null && expanded.id === entry.id) {
          setExpanded(null);
          return;
        }
        if (entry.kind !== "task") {
          setExpanded({ id: entry.id, phase: entry.excerpt ? "ready" : "empty", entry: entry, task: null, failure: null });
          return;
        }
        setExpanded({ id: entry.id, phase: "loading", entry: entry, task: null, failure: null });
        requestTask(entry.id, resolveFetch()).then(
          function (task) {
            setExpanded(function (previous) {
              if (previous === null || previous.id !== entry.id) return previous;
              return { id: entry.id, phase: task ? "ready" : "missing", entry: entry, task: task, failure: null };
            });
          },
          function (failure) {
            setExpanded(function (previous) {
              if (previous === null || previous.id !== entry.id) return previous;
              return { id: entry.id, phase: "error", entry: entry, task: null, failure: toFailure(failure) };
            });
          },
        );
      };

      try {
        /**
         * Read the pending queue through the host's admin proxy.
         *
         * A missing credential is folded into `available: false` rather than into
         * `failure`, because the panel must say "this machine has no admin credential"
         * and not "the request failed" - the user cannot fix the second by retrying.
         */
        var loadProposals = function () {
          setAdminState(function (previous) {
            return Object.assign({}, previous, { phase: "loading" });
          });
          return requestAdminJson("proposals-list", {}, resolveFetch()).then(
            function (data) {
              var payload = data && data.data !== undefined ? data.data : null;
              var list = null;
              if (payload && Array.isArray(payload.proposals)) list = payload.proposals;
              else if (Array.isArray(payload)) list = payload;
              setAdminState(function (previous) {
                return Object.assign({}, previous, {
                  phase: "ready", available: true, proposals: list && list.length ? list : (list || []),
                  failure: null,
                });
              });
            },
            function (failure) {
              var described = toFailure(failure);
              var missing = described && described.capabilityMissing === true;
              setAdminState(function (previous) {
                return Object.assign({}, previous, {
                  phase: "ready",
                  available: missing ? false : previous.available,
                  proposals: missing ? null : previous.proposals,
                  failure: missing ? null : described,
                });
              });
            },
          );
        };

        /**
         * Run one management action and fold its outcome back into `adminState`.
         *
         * The queue is re-read after a decision so what is on screen is what the core
         * now holds, not what it held before. Reads (`proposals-list`, export, inspect)
         * are not re-read: they do not change the queue.
         */
        var runAdmin = function (action, body) {
          setAdminState(function (previous) {
            return Object.assign({}, previous, { busy: action, failure: null, message: "" });
          });
          return requestAdminJson(action, body, resolveFetch()).then(
            function (data) {
              var result = data && data.data !== undefined ? data.data : null;
              var message = t("manage.actionDone");
              if (action === "backup-inspect") {
                setInspectResult(result === null ? "" : JSON.stringify(result, null, 2));
                message = t("manage.inspectTitle");
              } else if (action === "backup-export") {
                message = t("manage.exportDone")
                  + (result && typeof result === "object" && typeof result.path === "string" ? "：" + result.path : "");
              } else if (action === "backup-import") {
                message = t("manage.importDone");
              }
              setAdminState(function (previous) {
                return Object.assign({}, previous, { busy: "", message: message, failure: null });
              });
              if (action === "proposal-approve" || action === "proposal-reject" || action === "proposal-archive") {
                return loadProposals();
              }
              return null;
            },
            function (failure) {
              var described = toFailure(failure);
              var missing = described && described.capabilityMissing === true;
              setAdminState(function (previous) {
                return Object.assign({}, previous, {
                  busy: "",
                  available: missing ? false : previous.available,
                  failure: missing ? null : described,
                  message: "",
                });
              });
            },
          );
        };

        var panelProps = {
          phase: summaryState.phase,
          summary: summaryState.value,
          failure: summaryState.failure,
          expanded: expanded,
          onToggle: toggleEntry,
          onRetry: refresh,
          admin: adminState,
          importPath: importPath,
          inspectResult: inspectResult,
          onImportPathChange: setImportPath,
          onInspect: function () {
            if (importPath === "") {
              setAdminState(function (previous) {
                return Object.assign({}, previous, { message: t("manage.pathRequired") });
              });
              return;
            }
            runAdmin("backup-inspect", { path: importPath });
          },
          onAction: runAdmin,
          onLoadProposals: loadProposals,
          compose: compose,
          expandedProposal: expandedProposal,
          onExpandProposal: function (id) { setExpandedProposal(id); },
          onCompose: function (proposal) {
            if (!proposal) {
              setCompose(null);
              return;
            }
            // Seed the title from the candidate's first line so the reviewer edits
            // rather than starts from nothing - but never silently accept it, the
            // field is theirs to change and the confirm button stays disabled until
            // it holds something.
            var text = proposal.payload && typeof proposal.payload.discovery === "string"
              ? proposal.payload.discovery : "";
            var firstLine = text.split("\n").map(function (line) { return line.trim(); })
              .filter(function (line) { return line !== ""; })[0] || "";
            setCompose({ id: proposal.id, kind: "memory", title: firstLine.slice(0, 60) });
          },
          onComposeUpdate: function (field, value) {
            setCompose(function (previous) {
              if (!previous) return previous;
              var next = Object.assign({}, previous);
              next[field] = value;
              return next;
            });
          },
          onComposeEntry: function (proposal) {
            // The candidate's text becomes the body; the reviewer chose the kind and
            // the title. The scope is taken from the candidate's own payload rather
            // than invented here, so the entry lands where the candidate came from.
            var payload = proposal && proposal.payload ? proposal.payload : {};
            var text = typeof payload.discovery === "string" ? payload.discovery : "";
            var scope = { kind: "project" };
            if (typeof payload.projectId === "string" && payload.projectId !== "") {
              scope.projectId = payload.projectId;
            }
            return {
              id: compose.kind + ":" + String(proposal.id).slice(0, 16),
              baseRevision: 0,
              kind: compose.kind,
              title: compose.title,
              body: text,
              scope: scope,
            };
          },
          confirm: function (question) {
            // The panel's own confirmation, resolved through the host document so a
            // test can replace it without touching this code.
            var win = typeof window !== "undefined" ? window : null;
            if (win && typeof win.confirm === "function") return win.confirm(question);
            return true;
          },
        };
        return h("div", {
          className: ROOT_CLASS,
          "data-plugin": PLUGIN_ID,
          "data-view": VIEW_ID,
        },
          statusBar(h, {
            phase: summaryState.phase,
            summary: summaryState.value,
            failure: summaryState.failure,
            onRefresh: refresh,
          }),
          summaryState.phase === "ready" && summaryState.value
            ? overviewSection(h, summaryState.value)
            : null,
          viewNav(h, {
            view: view,
            onViewChange: function (next) {
              setView(next);
              // The queue is read when the reader opens the view, not on every render.
              // It needs the admin credential, so asking while the view is closed would
              // spend it for nothing.
              if (next === "manage" && adminState.phase === "idle") loadProposals();
            },
          }),
          // Search stays mounted in the two browsing views and is unmounted in the
          // grouped ones: a query box above a fixed category list would suggest the
          // two filter each other, which they do not.
          view === "all" || view === "kinds"
            ? searchSection(h, {
              query: query,
              onQueryChange: setQuery,
              onSubmit: submitSearch,
              state: searchState,
            })
            : null,
          view === "all" ? knowledgeSection(h, panelProps) : null,
          view === "kinds" ? knowledgeGroupsSection(h, panelProps) : null,
          view === "review" ? reviewSection(h, panelProps) : null,
          view === "tasks" ? taskSection(h, panelProps) : null,
          view === "manage" ? manageSection(h, panelProps) : null,
        );
      } catch (error) {
        return h("div", {
          className: ROOT_CLASS,
          "data-plugin": PLUGIN_ID,
          "data-view": VIEW_ID,
        }, h("div", { className: "amb-state amb-state-error" },
          t("error.render") + "：" + describeThrown(error)));
      }
    }

    /**
     * Slot registration outcome, readable for diagnostics. A missing slots
     * service or a rejected registration never throws out of `apply`, so the
     * rest of the client plugin keeps loading; the reason is preserved here.
     */
    var slotStatus = { available: false, reason: "", detail: "" };

    exports.name = PLUGIN_ID;
    exports.inject = ["slots"];
    exports.slotStatus = slotStatus;

    exports.apply = (ctx) => {
      var slots = ctx && ctx.slots ? ctx.slots : null;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        slotStatus.available = false;
        slotStatus.reason = "slots service unavailable";
        slotStatus.detail = t("slot.unavailable");
        warn(slotStatus.detail);
        return;
      }
      try {
        if (typeof ctx.effect === "function") {
          ctx.effect(function () { return installStyles(); }, "amb knowledge view styles");
        } else {
          installStyles();
        }
        slots.inject(VIEW_SLOT, function () {
          return slots.register({
            name: VIEW_SLOT,
            id: VIEW_ID,
            order: VIEW_ORDER,
            label: function () { return t("panel.tab"); },
          }, KnowledgePanel);
        });
        slotStatus.available = true;
        slotStatus.reason = "";
        slotStatus.detail = "";
      } catch (error) {
        slotStatus.available = false;
        slotStatus.reason = describeThrown(error);
        slotStatus.detail = t("slot.unavailable");
        warn(slotStatus.detail + " " + slotStatus.reason);
      }
    };

    return module.exports;
  },
});

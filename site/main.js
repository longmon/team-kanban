// 语言：放在 <head> 里同步执行，先定 lang 再渲染，避免闪烁。选择记在 localStorage（可能被禁用，均 try/catch）。
(function () {
  var root = document.documentElement;
  var META = {
    zh: { title: "Team Kanban：agent 发布，团队回复", desc: "开源、自托管。本机 agent 通过 MCP 把投票、报告、架构图等页面发布给团队，团队在浏览器里查看和填写，提交再交还给 agent。" },
    en: { title: "Team Kanban: your agent publishes, your team responds", desc: "Open source and self-hosted. Local agents publish polls, reports and diagrams over MCP; your team views and answers them in a browser, and the submissions go back to the agent." },
  };
  function saved() { try { return localStorage.getItem("tk-lang"); } catch (e) { return null; } }
  function apply(l) {
    root.lang = l === "en" ? "en" : "zh-CN";
    var m = META[l === "en" ? "en" : "zh"];
    document.title = m.title;
    var d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute("content", m.desc);
  }
  var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "zh";
  apply(saved() || (/^zh/i.test(nav) ? "zh" : "en"));

  document.addEventListener("DOMContentLoaded", function () {
    apply(root.lang === "en" ? "en" : "zh"); // 补上 meta（head 解析到脚本时它已存在，这里保险）
    document.getElementById("lang-toggle").addEventListener("click", function () {
      var next = root.lang === "en" ? "zh" : "en";
      apply(next);
      try { localStorage.setItem("tk-lang", next); } catch (e) {}
    });

    // 复制按钮
    document.querySelectorAll(".copy").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var text = btn.parentNode.querySelector("code").textContent;
        var done = function () {
          var zh = btn.querySelector('[lang="zh"]'), en = btn.querySelector('[lang="en"]');
          zh.textContent = "已复制"; en.textContent = "Copied"; btn.classList.add("ok");
          setTimeout(function () { zh.textContent = "复制"; en.textContent = "Copy"; btn.classList.remove("ok"); }, 1600);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
      });
    });

    // 首屏演示：只播放一次（可重放）；减少动效时保持终态
    var demo = document.getElementById("demo");
    var replay = document.getElementById("replay");
    if (!demo || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var steps = demo.querySelectorAll("[data-at]");
    var bar = function (k) { return demo.querySelector('[data-bar="' + k + '"]'); };
    var num = function (k) { return demo.querySelector('[data-n="' + k + '"]'); };
    var wait = demo.querySelector(".t-wait");
    // 每步：[延时 ms, 步号, 额外动作]
    var plan = [
      [300, 0], [900, 1], [1000, 2], [800, 3],
      [1100, 4, function () { bar("b").dataset.w = "100"; num("b").textContent = "1"; }],
      [800, 5, function () { bar("a").dataset.w = "50"; bar("b").dataset.w = "50"; num("a").textContent = "1"; }],
      [800, 6, function () { delete bar("a").dataset.w; delete bar("b").dataset.w; num("b").textContent = "2"; }],
      [700, 7, function () { wait.classList.add("done"); }],
      [900, 8],
    ];
    var timers = [];
    function play() {
      timers.forEach(clearTimeout); timers = [];
      replay.hidden = true;
      steps.forEach(function (el) { el.classList.remove("on"); });
      wait.classList.remove("done");
      ["a", "b", "c"].forEach(function (k) { bar(k).dataset.w = "0"; num(k).textContent = "0"; });
      demo.classList.add("playing");
      var t = 0;
      plan.forEach(function (p) {
        t += p[0];
        timers.push(setTimeout(function () {
          demo.querySelectorAll('[data-at="' + p[1] + '"]').forEach(function (el) { el.classList.add("on"); });
          if (p[2]) p[2]();
        }, t));
      });
      timers.push(setTimeout(function () { replay.hidden = false; }, t + 400));
    }
    replay.addEventListener("click", play);
    play();
  });
})();

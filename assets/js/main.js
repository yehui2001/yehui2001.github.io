(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var themeButton = document.querySelector(".theme-toggle");
  var navButton = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".site-nav");
  var backToTop = document.querySelector(".back-to-top");
  var progress = document.querySelector(".reading-progress span");

  function currentTheme() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function updateCommentTheme(theme) {
    var frame = document.querySelector(".utterances-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(
        {
          type: "set-theme",
          theme: theme === "dark" ? "github-dark" : "github-light",
        },
        "https://utteranc.es",
      );
    }
  }

  if (themeButton) {
    themeButton.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      if (next === "dark") root.dataset.theme = "dark";
      else delete root.dataset.theme;
      localStorage.setItem("theme", next);
      updateCommentTheme(next);
    });
  }

  if (document.querySelector(".comments")) {
    var commentObserver = new MutationObserver(function () {
      if (document.querySelector(".utterances-frame")) {
        updateCommentTheme(currentTheme());
        commentObserver.disconnect();
      }
    });
    commentObserver.observe(document.querySelector(".comments"), {
      childList: true,
      subtree: true,
    });
  }

  if (navButton && nav) {
    navButton.addEventListener("click", function () {
      var open = body.classList.toggle("nav-open");
      navButton.setAttribute("aria-expanded", String(open));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        body.classList.remove("nav-open");
        navButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      body.classList.remove("nav-open");
      if (navButton) navButton.setAttribute("aria-expanded", "false");
      var searchInput = document.getElementById("search-input");
      if (searchInput && document.activeElement === searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input"));
        searchInput.blur();
      }
    }
  });

  function onScroll() {
    var y = window.scrollY;
    if (backToTop) backToTop.classList.toggle("visible", y > 480);

    if (progress) {
      var available =
        document.documentElement.scrollHeight - window.innerHeight;
      var percent = available > 0 ? Math.min(100, (y / available) * 100) : 0;
      progress.style.width = percent + "%";
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (backToTop) {
    backToTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      }[char];
    });
  }

  var input = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  var status = document.getElementById("search-status");

  if (input && results && status) {
    var posts = [];

    fetch("/search.json")
      .then(function (response) {
        if (!response.ok) throw new Error("Search index unavailable");
        return response.json();
      })
      .then(function (data) {
        posts = data;
        status.textContent = "开始输入以搜索 " + posts.length + " 篇文章";
      })
      .catch(function () {
        status.textContent = "搜索索引暂时无法加载，请稍后再试。";
      });

    input.addEventListener("input", function () {
      var query = input.value.trim().toLocaleLowerCase("zh-CN");
      if (!query) {
        results.innerHTML = "";
        status.textContent = "开始输入以搜索 " + posts.length + " 篇文章";
        return;
      }

      var tokens = query.split(/\s+/).filter(Boolean);
      var matches = posts.filter(function (post) {
        var haystack = [
          post.title,
          post.description,
          post.categories,
          post.content,
        ]
          .join(" ")
          .toLocaleLowerCase("zh-CN");
        return tokens.every(function (token) {
          return haystack.indexOf(token) !== -1;
        });
      });

      status.textContent =
        "找到 " +
        matches.length +
        " 条与“" +
        input.value.trim() +
        "”相关的结果";

      if (!matches.length) {
        results.innerHTML =
          '<div class="search-empty"><span>∅</span>没有找到相关内容，换个关键词试试。</div>';
        return;
      }

      results.innerHTML = matches
        .map(function (post) {
          return (
            "<article>" +
            "<time>" +
            escapeHtml(post.date) +
            "</time>" +
            '<div><h2><a href="' +
            encodeURI(post.url) +
            '">' +
            escapeHtml(post.title) +
            "</a></h2>" +
            "<p>" +
            escapeHtml(post.description) +
            "</p>" +
            '<span class="result-category">' +
            escapeHtml(post.categories || "未分类") +
            "</span></div>" +
            '<a class="round-arrow" href="' +
            encodeURI(post.url) +
            '" aria-label="打开文章">↗</a>' +
            "</article>"
          );
        })
        .join("");
    });
  }
})();

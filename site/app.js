/* SwarmOracle introduction: both languages are present in the HTML. */
(function () {
  "use strict";

  function bindImageLanguages(selector, prefix) {
    document.querySelectorAll(selector).forEach(function (figure) {
      var attribute = "data-" + prefix;
      figure.querySelectorAll("[" + attribute + "-lang]").forEach(function (button) {
        button.addEventListener("click", function () {
          var language = button.getAttribute(attribute + "-lang");
          figure.querySelectorAll("[" + attribute + "-lang]").forEach(function (control) {
            control.setAttribute("aria-pressed", String(control === button));
          });
          figure.querySelectorAll("[" + attribute + "-image]").forEach(function (image) {
            image.hidden = image.getAttribute(attribute + "-image") !== language;
          });
          figure.querySelectorAll("[" + attribute + "-caption]").forEach(function (caption) {
            caption.hidden = caption.getAttribute(attribute + "-caption") !== language;
          });
        });
      });
    });
  }
  bindImageLanguages("[data-illustration]", "art");
  bindImageLanguages("[data-capture]", "capture");

  var drawer = document.getElementById("drawer");
  var burger = document.getElementById("burger");
  var closeMenu = document.getElementById("drawerClose");
  var background = [document.getElementById("nav"), document.querySelector("main"), document.querySelector("footer")];
  var lightbox = document.getElementById("lightbox");
  var lastScreenshot = null;

  function syncScrollLock() {
    document.body.classList.toggle("has-overlay", drawer.classList.contains("open") || Boolean(lightbox && lightbox.open));
  }

  function setDrawer(open, restoreFocus) {
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    drawer.inert = !open;
    burger.setAttribute("aria-expanded", String(open));
    background.forEach(function (node) { if (node) node.inert = open; });
    syncScrollLock();
    if (open) closeMenu.focus();
    else if (restoreFocus) burger.focus();
  }

  burger.addEventListener("click", function () { setDrawer(true, false); });
  closeMenu.addEventListener("click", function () { setDrawer(false, true); });
  drawer.querySelectorAll("a").forEach(function (link) {
    link.addEventListener("click", function () {
      setDrawer(false, false);
      var target = document.querySelector(link.getAttribute("href"));
      if (target) {
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    });
  });
  drawer.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDrawer(false, true);
      return;
    }
    if (event.key !== "Tab") return;
    var items = drawer.querySelectorAll("button, a[href]");
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  var desktop = window.matchMedia("(min-width: 1040px)");
  function onDesktop(event) {
    if (event.matches && drawer.classList.contains("open")) {
      setDrawer(false, false);
      document.querySelector(".nav__brand").focus();
    }
  }
  if (desktop.addEventListener) desktop.addEventListener("change", onDesktop);
  else desktop.addListener(onDesktop);

  var copyStatus = document.getElementById("copy-status");
  document.querySelectorAll(".copy").forEach(function (button) {
    button.addEventListener("click", function () {
      var code = document.getElementById(button.getAttribute("data-copy-target"));
      if (!code) return;
      button.disabled = true;
      copyStatus.textContent = "";
      var pending = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(code.textContent)
        : Promise.reject(new Error("Clipboard unavailable"));
      pending.then(function () {
        copyStatus.textContent = "已复制命令。 / Commands copied.";
      }).catch(function () {
        var selection = window.getSelection();
        if (selection) {
          var range = document.createRange();
          range.selectNodeContents(code);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        copyStatus.textContent = "未能自动复制。请复制已选中的命令。 / Automatic copy failed. Copy the selected commands.";
      }).finally(function () { button.disabled = false; });
    });
  });

  if (lightbox && typeof lightbox.showModal === "function") {
    var image = document.getElementById("lightbox-image");
    var caption = document.getElementById("lightbox-caption");
    document.querySelectorAll("[data-lightbox]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        var thumbnail = link.querySelector("img");
        lastScreenshot = link;
        image.src = link.href;
        image.alt = link.getAttribute("data-caption");
        image.width = Number(thumbnail.getAttribute("width"));
        image.height = Number(thumbnail.getAttribute("height"));
        image.lang = link.lang || "zh-CN";
        caption.textContent = link.getAttribute("data-caption");
        caption.lang = image.lang;
        document.getElementById("lightbox-original").href = link.href;
        lightbox.showModal();
        lightbox.querySelector(".lightbox__body").scrollTop = 0;
        syncScrollLock();
      });
    });
    document.getElementById("lightbox-close").addEventListener("click", function () { lightbox.close(); });
    lightbox.addEventListener("click", function (event) {
      if (event.target !== lightbox) return;
      var bounds = lightbox.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) lightbox.close();
    });
    lightbox.addEventListener("close", function () {
      syncScrollLock();
      if (lastScreenshot) lastScreenshot.focus();
    });
  }
})();

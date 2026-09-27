/* Theme toggle wiring. The pre-paint snippet in each page <head> already
   applied the saved choice; this only wires the #themeBtn button. */
(function () {
  function paint(btn) {
    btn.textContent =
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'Light mode'
        : 'Dark mode';
  }
  function init() {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    paint(btn);
    btn.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      try {
        localStorage.setItem('stm32f1-theme', dark ? 'light' : 'dark');
      } catch (e) {}
      paint(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

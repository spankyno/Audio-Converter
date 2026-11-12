/* Tema claro/oscuro. Archivo externo (sin scripts inline) para poder usar una CSP estricta. */
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (_) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) root.classList.add('dark');

  // Abre la política de privacidad plegable al llegar con #privacidad (o al pulsar el enlace)
  function openHashDetails() {
    var el = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView(); }
  }
  window.addEventListener('hashchange', openHashDetails);

  document.addEventListener('DOMContentLoaded', function () {
    openHashDetails();
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var isDark = root.classList.toggle('dark');
      try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch (_) {}
    });
  });
})();

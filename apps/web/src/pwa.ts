// Keep development reloads outside a persistent service worker's scope.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((error: unknown) => {
        console.error('Corner could not enable offline navigation handling.', error);
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

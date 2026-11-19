const bridge = window.magpie;
(async () => {
  try {
    await bridge?.ready;
    if (bridge?.service) {
      const service = new URL(bridge.service, location.href);
      location.replace(new URL(service.pathname + service.search + service.hash, location.origin).href);
    } else {
      location.replace('http://127.0.0.1:3489');
    }
  } catch (error) {
    document.body.textContent = `质量检测后台无法打开：${error?.message || error}`;
  }
})();

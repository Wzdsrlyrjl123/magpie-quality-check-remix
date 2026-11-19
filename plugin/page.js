const bridge = window.magpie;
(async () => {
  try {
    await bridge?.ready;
    location.replace(bridge?.service || 'http://127.0.0.1:3489');
  } catch (error) {
    document.body.textContent = `质量检测后台无法打开：${error?.message || error}`;
  }
})();

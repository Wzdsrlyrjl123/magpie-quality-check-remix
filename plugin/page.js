const bridge = window.magpie;

function loadSession() {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = `./sidebar-session.js?${Date.now()}`;
    script.onload = script.onerror = () => {
      script.remove();
      resolve(window.qualityCheckSidebar);
    };
    document.head.appendChild(script);
  });
}

(async () => {
  try {
    if (!bridge) throw Error('无法连接 Magpie 插件桥接，请重新打开侧边栏。');
    await bridge.ready;
    const proxy = new URL('./_magpie/service/', location.href);
    if (!bridge.service && !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)) {
      throw Error('当前 Magpie Web 未提供插件服务代理，请更新 Magpie 宿主。');
    }
    let session;
    for (let attempt = 0; !session && attempt < 15; attempt++) {
      session = await loadSession();
      if (!session) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!session?.token) throw Error('检测后台未就绪，请检查 Magpie 插件日志。');
    const base = bridge.service ? proxy : new URL(session.origin);
    location.replace(new URL(`sidebar/${encodeURIComponent(session.token)}/`, base).href);
  } catch (error) {
    document.body.textContent = `质量检测后台无法打开：${error?.message || error}`;
  }
})();

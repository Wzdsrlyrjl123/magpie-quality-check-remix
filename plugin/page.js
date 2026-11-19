const service = window.magpie?.service;
if (service) location.replace(service);
else document.body.textContent = '当前 Magpie 版本不支持插件页面服务，请升级后重试。';

# 发布和更新

此分支的 Magpie 安装地址：

```text
github:Wzdsrlyrjl123/magpie-intelligence-check
```

Magpie 通过仓库安装时直接读取 `package.json` 和 `bin/`，不会替用户编译 Go。
因此修改后台源码后，必须重新构建并提交五个平台的二进制。

## 发布新版本

1. 更新 `package.json` 的版本号，例如从 `0.4.1` 改为 `0.4.2`。
2. 执行检查和构建：

   ```sh
   go test ./...
   go vet ./...
   node --test plugin/*.test.mjs scripts/answer-analysis.test.mjs
   node scripts/build-release.mjs
   node scripts/package-check.mjs
   node scripts/plugin-check.mjs
   ```

3. 确认 `plugin/gate.middleware.js` 只有初始放行函数。不要提交运行后生成的模型状态、探针别名、数据库、网关凭据或本机配置。
4. 将源码、版本号和 `bin/quality-check-*` 一起提交并推送到 `main`。
5. 为同一提交创建并推送对应标签，例如 `v0.4.2`。GitHub Actions 会检查版本号、重新构建五个平台发行包，并将校验清单和安装包上传到 GitHub Release。也可手动运行工作流，仅构建和保存产物。

用户在 Magpie 插件页面点击更新，或执行：

```sh
magpie plugin update
```

`magpie plugin update` 会检查所有已安装插件。保持同一个 GitHub 安装地址，后续无需再选择本地目录。

从本地路径迁移时，先停用或移除本地插件的登记，再添加 GitHub 地址，避免两个后台争用默认数据目录。检测数据默认保存在 `~/.config/magpie-quality-check`，不会因为移除插件登记而自动删除。

## 本地开发

开发时可继续使用本地路径。运行插件会更新门禁文件，因此发布前应在干净的发布副本中构建和检查。原项目和上游链接保留在 README 与 LICENSE 中。

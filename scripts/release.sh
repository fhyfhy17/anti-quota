#!/bin/bash

# 发布脚本 - 打包扩展并创建 GitHub Release
set -e

# 获取版本号
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "🚀 发布 Anti Quota v$VERSION..."

# 编译 TypeScript
echo "📦 编译中..."
npm run compile

# 打包扩展
echo "📦 打包扩展..."
npx vsce package --no-dependencies

VSIX_FILE="anti-quota-$VERSION.vsix"

if [ ! -f "$VSIX_FILE" ]; then
    echo "❌ 找不到 $VSIX_FILE"
    exit 1
fi

# 检查 tag 是否存在
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "⚠️  Tag $TAG 已存在，跳过创建"
else
    echo "🏷️  创建 tag $TAG..."
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "$TAG"
fi

# 创建 GitHub Release
echo "📤 创建 GitHub Release..."
gh release create "$TAG" "$VSIX_FILE" \
    --title "Anti Quota $TAG" \
    --notes "## 安装方式

1. 下载 \`$VSIX_FILE\`
2. 在 VS Code 中按 \`Cmd+Shift+P\` 
3. 搜索 \`Install from VSIX\`
4. 选择下载的文件

## 功能
- Antigravity 配额实时监控
- 自动刷新配额显示
- 状态栏显示当前配额"

echo "✅ 发布完成!"
echo "🔗 https://github.com/fhyfhy17/anti-quota/releases/tag/$TAG"

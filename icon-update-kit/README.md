# 三个 App 的统一图标

按已确认的预览制作：书架为赤陶橙与奶白色书本；房屋账本为青绿与实心房屋、镂空闪电；牙牙呓语为靛蓝背景、粉色睡猪、放大的星星和梦话气泡。Babble 使用已选定的 B 款圆润外翻耳，右耳缩小并向外轻垂，气泡与省略号已放大。

SVG 是可缩放源文件，PNG 使用同一份源文件导出。安装资源使用不透明的满幅方形底，由系统裁切圆角；Babble 的 maskable 图标另留安全区。

Babble 的图标、网页入口、两份 manifest、侧栏和关于页面已经替换。书架与房屋账本的资源及引用修改准备在本包中。

从三个项目所在的共同父目录执行：

```sh
python3 babble/icon-update-kit/install.py
python3 babble/icon-update-kit/install.py --apply
```

第一条只检查，第二条替换。安装器会先核对全部文件，确认它们仍与准备补丁时的版本一致，再写入；原文件保存在 `backups/`。已经安装的文件会跳过。书架当前的 OCR 改动在补丁准备时已保留。

如果在书架或房屋账本各自的对话中更新，请直接复制 `assets/virtual-bookshelf/` 或 `assets/house-ledger/` 的对应资源，并修改当前项目的图标引用与缓存。上面的安装器会处理两个项目，不适合只获准写入单个项目的对话。

图标替换后，还需要正常提交并发布各项目。已安装的主屏幕或程序坞图标可能由系统单独缓存；优先尝试关闭 App 后重新打开。请先确认同步或备份可用，再考虑重新添加 App。

重新导出 PNG（macOS）：

```sh
swift -module-cache-path /tmp/babble-icon-swift-cache babble/icon-update-kit/export.swift SOURCE.svg OUTPUT_DIRECTORY 180 512
```

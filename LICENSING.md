# 许可说明

Copyright (c) 2026 tsuru0805 (晚晚).

本仓内容按下面三层授权。同一个文件只属于其中一层。

| 层 | 范围 | 许可 |
|---|---|---|
| 软件 | 源代码（`src/`、`scripts/`、`tests/` 里的代码）、配置文件（`pyproject.toml`、`Dockerfile`、`.github/` 下的工作流）、以后加入的网页包里可执行的 HTML/CSS/JavaScript | [PolyForm Noncommercial 1.0.0](LICENSE) |
| 文档与自有素材 | README、`docs/`、issue 模板，以及以后加入的、由本仓作者自己制作的图片与其他素材 | [CC BY-NC 4.0](LICENSE-CONTENT) |
| 第三方 | OpenStreetMap 数据及由它建出的底图库、Natural Earth 国界、Wikidata 坐标、测试里引用的地点服务响应格式、依赖包 | 各自原许可，**不随本仓改授权**，逐项见 [NOTICE](NOTICE) |

- 个人、爱好、学习、研究等非商业用途可以使用、修改、再分发（再分发须附上许可全文或链接，以及 NOTICE 里以 `Required Notice:` 开头的行）。
- **商业用途不在授权范围内**，需要另行书面授权——联系 [tsuru0805](https://github.com/tsuru0805)。

## 地图数据单列

由 `scripts/build_basemap.py` 从 OpenStreetMap 区域包建出的底图库属于 **ODbL 1.0**（<https://opendatacommons.org/licenses/odbl/1-0/>），不属于上面的 CC BY-NC 4.0：

- 本仓**不分发**完整底图库，使用者在自己机器上建。
- 使用或再分发底图库、以及显示由它画出的地图时，都必须署名「© OpenStreetMap contributors」。
- 以后随在线试玩发布的小块示例数据（如有）同样属 ODbL，随附 ODbL 说明与上述署名。
- 本仓测试里录制的 Nominatim 响应（`tests/places/fixtures/nominatim_*.json`）是 OSM 数据的极小摘录，同属 ODbL，文件内已带署名。

## 地点服务的使用条款

谷歌、高德的地点服务由使用者用自己的钥匙调用，调用与存储受该服务自己的条款约束，与本仓许可无关。条款冲突的具体位置见 README「地图与地点服务」一节。

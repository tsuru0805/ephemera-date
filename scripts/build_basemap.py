#!/usr/bin/env python3
"""建一个城市的本地底图库（OSM → SQLite），给约会地图与步行时间用。

例：
  # 已有区域包，按范围裁剪（bbox = 最小经度,最小纬度,最大经度,最大纬度）
  python scripts/build_basemap.py --pbf /tmp/osm/monaco-latest.osm.pbf \\
      --bbox 7.41,43.72,7.44,43.75 --out ~/Library/Application\\ Support/ephemera/maps/monaco.sqlite

  # 从 Geofabrik 下载区域包（只下一次、md5 校验、已下载就复用）+ 城市名查范围（Nominatim 一次）
  python scripts/build_basemap.py --region europe/monaco --city "Monaco" --workdir /tmp/osm --out monaco.sqlite

  # 补海面（OSM 的海是海岸线，要从 osmdata 的 water-polygons-split-4326 里取；ODbL）
  #   下载 https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip 并解压
  python scripts/build_basemap.py ... --sea /tmp/osm/water-polygons-split-4326/water_polygons.shp

输出库在 EPHEMERA_MAP_DIR（默认 <数据目录>/maps）里时，地图会自动按覆盖范围选用。

数据许可：产出的库由 OpenStreetMap 数据建出，属 ODbL 1.0（https://opendatacommons.org/licenses/odbl/1-0/），
页面与任何再分发都必须署名「© OpenStreetMap contributors」。区域包来源 Geofabrik（https://download.geofabrik.de/），
请勿用 OSM 官方 API 批量下载；同一区域包下载一次反复用。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ephemera_date.maps import build as B  # noqa: E402
from ephemera_date.places.config import map_dir  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="从 OSM 区域包建一个城市的本地底图库（ODbL，© OpenStreetMap contributors）")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pbf", help="已下载的区域包 .osm.pbf")
    src.add_argument("--region", help="Geofabrik 区域路径，例 asia/china/shanghai、europe/monaco")
    rng = ap.add_mutually_exclusive_group(required=True)
    rng.add_argument("--bbox", help="最小经度,最小纬度,最大经度,最大纬度")
    rng.add_argument("--city", help="城市/区名，用 Nominatim 查一次范围")
    ap.add_argument("--out", help="输出库路径（默认 <EPHEMERA_MAP_DIR>/<名字>.sqlite）")
    ap.add_argument("--name", help="库名（默认取输出文件名）")
    ap.add_argument("--buffer-m", type=float, default=B.DEFAULT_BUFFER_M, help="范围外缓冲带（米，默认 2000）")
    ap.add_argument("--workdir", default="/tmp/ephemera-basemap", help="下载与裁剪中间文件目录")
    ap.add_argument("--mirror", default=B.GEOFABRIK, help="Geofabrik 或其镜像根地址")
    ap.add_argument("--sea", help="water_polygons.shp（可选，补海面）")
    ap.add_argument("--max-nodes", type=int, default=B.DEFAULT_MAX_NODES, help="区域包节点数上限（超了报错）")
    ap.add_argument("--max-kept", type=int, default=B.DEFAULT_MAX_KEPT, help="裁剪后保留对象数上限")
    ap.add_argument("--max-memory-mb", type=int, default=B.DEFAULT_MAX_MEMORY_MB, help="进程峰值内存上限（MB）")
    a = ap.parse_args(argv)
    if a.buffer_m < 0:
        print("建底图失败：--buffer-m 不能是负数（负缓冲会把覆盖范围里的数据裁掉）", file=sys.stderr)
        return 1

    t0 = time.time()
    try:
        bb = B.parse_bbox(a.bbox) if a.bbox else B.bbox_for_name(a.city)
        pbf = Path(a.pbf) if a.pbf else B.download(a.region, a.workdir, base=a.mirror)
        name = a.name or (Path(a.out).stem if a.out else (a.city or pbf.name.split("-latest")[0]).replace(" ", "_"))
        out = Path(a.out).expanduser() if a.out else map_dir() / f"{name}.sqlite"
        st = B.build_city(pbf, out, bb, buffer_m=a.buffer_m, workdir=a.workdir, sea_shp=a.sea, name=name,
                          max_nodes=a.max_nodes, max_kept=a.max_kept, max_memory_mb=a.max_memory_mb)
    except B.BuildError as e:
        print(f"建底图失败：{e}", file=sys.stderr)
        return 1
    if st["crop"].get("skipped_nested_relations"):
        print(f"注意：跳过了 {st['crop']['skipped_nested_relations']} 个成员里套关系的多边形关系"
              "（OSM 规范不允许，本脚本不支持），这些面不会出现在底图上。", file=sys.stderr)
    st["bbox"] = {"minlat": bb[0], "maxlat": bb[1], "minlon": bb[2], "maxlon": bb[3]}
    st["total_seconds"] = round(time.time() - t0, 1)
    print(json.dumps(st, ensure_ascii=False, indent=2))
    print(f"完成：{out}（{st['bytes'] / 1e6:.1f} MB）。{B.LICENSE_NOTE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""约会地图：本地 OSM 底图库 → 分层 SVG 路径 + 路线 + 站点；本地路网步行时间；建底图。

公开接口（引擎 ports.py 的默认接线：地图 = build_map + MapStore，步行 = walk_between）
------------------------------------------------
渲染与步行（render.py）::

    build_map(view: dict, store: MapStore | None = None, speed_kmh: float | None = None) -> dict
        view = 约会公开投影（只含已公开站；形状见 render 模块说明）。输出 {W, H, layers, stops, legs,
        walk_paths, stats, area, attribution, basemap, fill_rule="evenodd"}；legs[].minutes = 本地路网最短路 ÷
        步行速度，找不到路网时 minutes/meters 为 None、reason/reason_text 说明（不退直线冒充）；
        legs[].schematic（直线示意）/ unverified_connector_m（90–300 米未核实接驳）/ search_margin_m（寻路窗口）/
        has_ferry + ferry[{pts, meters, minutes}]（坐轮渡的部分；minutes 含等船）；layers.ferry = 轮渡航线。
        没有任何底图库 / 地点都不在底图范围 → raise MapUnavailable(code, text)。
    walk_between(origin: (lat, lng), dest: (lat, lng), store=None, speed_kmh=None) -> places.WalkResult
        给 AI 查路工具用；source="local"；unverified_connector_m 同上；ferry = 轮渡段 ({meters, minutes}, ...)。
    MapStore(src: 目录 | 文件 | 列表 | None = EPHEMERA_MAP_DIR)
        .maps: list[Basemap]  .coverage(lat, lng) -> {covered, basemap, reason?, reason_text?}
        .pick(points) -> Basemap（覆盖点数最多的库）
    minutes_for(meters, speed_kmh) -> int
    REASONS: dict[code, 中文]   # no_basemap / out_of_coverage / no_network / disconnected / on_water / not_walk
    ATTRIBUTION = "© OpenStreetMap contributors"

建底图（build.py；CLI = scripts/build_basemap.py）::

    build_city(pbf, out, bbox, *, buffer_m=2000, workdir=None, sea_shp=None, name=None, **limits) -> dict
    crop(src_pbf, bbox, out_pbf, *, max_nodes, max_kept, max_memory_mb, location_storage) -> dict
        # 几何相交（穿框/包围都算）；嵌套关系明确跳过并在 skipped_nested_relations 里报；超上限 BuildError
    build(pbf, out_db, *, bbox, buffer_m, name, source) -> dict
    add_sea(water_polygons_shp, db) -> int ; download(region, dest_dir, base=GEOFABRIK) -> Path
    parse_bbox("minlon,minlat,maxlon,maxlat") -> (minlat, maxlat, minlon, maxlon)
    bbox_for_name(name, provider=None, *, transport=None) -> bbox   # 默认走数据目录缓存与跨进程限速

数据许可：底图库属 ODbL 1.0，页面必须显示 ATTRIBUTION。
"""
from __future__ import annotations

from .render import ATTRIBUTION, REASONS, Basemap, MapStore, MapUnavailable, build_map, minutes_for, walk_between

__all__ = ["ATTRIBUTION", "REASONS", "Basemap", "MapStore", "MapUnavailable", "build_map", "minutes_for",
           "walk_between"]

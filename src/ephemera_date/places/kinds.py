"""站类别：三家地点服务的类型 → 同一套 (大类, 细类)。

大类代码与细类中文以引擎的站类别表（ephemera_date.kinds）为准；这里的 SUBTYPES 是那张表的代码与细类副本，
测试据此校验映射目标都存在，并核对两份一致。对不上的类型 = (None, None)，留给用户手动选。

- 谷歌：Places API (New) Table A。
  来源 https://developers.google.com/maps/documentation/places/web-service/place-types （Table A）
- 高德：Web 服务 POI 分类编码（typecode，6 位，两位一层）。本仓只用编码本身，不收录编码表的分类名；
  编码定义见高德开放平台「相关下载」https://lbs.amap.com/api/webservice/download 的 POI 分类编码表。
- OSM：Nominatim 结果的 class/type（jsonv2 里叫 category/type；Photon 里叫 osm_key/osm_value），即 OSM 主标签。
  来源 https://wiki.openstreetmap.org/wiki/Map_features 、https://nominatim.org/release-docs/latest/api/Output/
"""
from __future__ import annotations

MOMENT = "moment"   # 「一件事」：没有固定地点，不参与自动分类

SUBTYPES: dict[str, tuple[str, ...]] = {
    'train': ('车站', '地铁站', '巴士站', '路口', '店门口'),
    'dinner': ('餐馆', '拉面', '寿司', '烤肉', '居酒屋', '定食', '意大利菜', '法餐', '中餐', '韩餐'),
    'cafe': ('咖啡馆', '茶馆', '喫茶店', '早午餐'),
    'sweets': ('甜品店', '面包店', '冰淇淋', '和果子', '蛋糕店'),
    'bar': ('酒吧', '红酒吧', '精酿', '居酒屋二次会', '夜景酒廊'),
    'cinema': ('电影院', '迷你影院'),
    'live': ('Live house', '剧场', '音乐会', '演唱会', '落语·曲艺'),
    'museum': ('美术馆', '博物馆', '画廊', '特展', '科学馆'),
    'aquarium': ('水族馆', '动物园', '植物园', '猫咖·动物咖啡'),
    'amusement': ('主题乐园', '游乐园', '摩天轮'),
    'play': ('卡拉OK', '游戏厅', '保龄球', '密室逃脱', '桌游'),
    'walk': ('街道', '河边', '海边', '商店街'),
    'park': ('公园', '庭园', '赏花', '赏枫'),
    'viewpoint': ('展望台', '夜景', '观景塔'),
    'shrine': ('神社', '寺庙', '教会'),
    'shopping': ('商场', '服装', '眼镜店', '书店', '文具', '杂货', '花店', '超市'),
    'onsen': ('温泉', '钱汤', 'SPA', '桑拿'),
    'stay': ('酒店', '旅馆', '民宿'),
    'moment': (),
}
KIND_CODES: tuple[str, ...] = tuple(SUBTYPES)


# ── 谷歌地点类型 → (大类, 细类) ──────────────────────────────────────────────────────────
# 一条 = 谷歌 Table A 类型: (大类, 细类|None)。没登记的类型 = 对不上。
# 「弱」类型(笼统的 restaurant/cafe/store…)排在 primaryType 时,若 types 里有同大类、带细类的更具体类型,改用那个。
_DINNER_PLAIN = (
    "afghani", "african", "american", "argentinian", "asian_fusion", "asian", "australian", "austrian",
    "bangladeshi", "basque", "bavarian", "belgian", "brazilian", "british", "buffet", "burmese", "burrito",
    "cajun", "californian", "cambodian", "caribbean", "chicken", "chicken_wings", "chilean", "colombian",
    "croatian", "cuban", "czech", "danish", "dutch", "eastern_european", "ethiopian", "european", "falafel",
    "fast_food", "filipino", "fish_and_chips", "fondue", "fusion", "german", "greek", "gyro", "halal",
    "hamburger", "hawaiian", "hot_dog", "hot_pot", "hungarian", "indian", "indonesian", "irish", "israeli",
    "japanese", "latin_american", "lebanese", "malaysian", "mediterranean", "mexican", "middle_eastern",
    "mongolian_barbecue", "moroccan", "north_indian", "oyster_bar", "pakistani", "persian", "peruvian",
    "polish", "portuguese", "romanian", "russian", "scandinavian", "seafood", "shawarma", "soul_food", "soup",
    "south_american", "south_indian", "southwestern_us", "spanish", "sri_lankan", "swiss", "taco", "taiwanese",
    "tapas", "tex_mex", "thai", "tibetan", "turkish", "ukrainian", "vegan", "vegetarian", "vietnamese",
    "western", "yakitori", "japanese_curry",
)
GOOGLE_TYPE_MAP: dict[str, tuple[str, str | None]] = {
    # 集合(交通)
    "train_station": ("train", "车站"), "light_rail_station": ("train", "车站"), "tram_stop": ("train", "车站"),
    "transit_station": ("train", "车站"), "transit_stop": ("train", "车站"),
    "subway_station": ("train", "地铁站"),
    "bus_station": ("train", "巴士站"), "bus_stop": ("train", "巴士站"),
    # 晚餐
    "restaurant": ("dinner", "餐馆"), "fine_dining_restaurant": ("dinner", "餐馆"),
    "family_restaurant": ("dinner", "餐馆"), "diner": ("dinner", "餐馆"), "bistro": ("dinner", "法餐"),
    "ramen_restaurant": ("dinner", "拉面"), "sushi_restaurant": ("dinner", "寿司"),
    "yakiniku_restaurant": ("dinner", "烤肉"), "korean_barbecue_restaurant": ("dinner", "烤肉"),
    "barbecue_restaurant": ("dinner", "烤肉"),
    "japanese_izakaya_restaurant": ("dinner", "居酒屋"), "tonkatsu_restaurant": ("dinner", "定食"),
    "italian_restaurant": ("dinner", "意大利菜"), "pizza_restaurant": ("dinner", "意大利菜"),
    "french_restaurant": ("dinner", "法餐"),
    "chinese_restaurant": ("dinner", "中餐"), "cantonese_restaurant": ("dinner", "中餐"),
    "dim_sum_restaurant": ("dinner", "中餐"), "dumpling_restaurant": ("dinner", "中餐"),
    "chinese_noodle_restaurant": ("dinner", "中餐"),
    "korean_restaurant": ("dinner", "韩餐"),
    "noodle_shop": ("dinner", None), "steak_house": ("dinner", None), "gastropub": ("dinner", None),
    "deli": ("dinner", None), "food_court": ("dinner", None), "sandwich_shop": ("dinner", None),
    "salad_shop": ("dinner", None), "kebab_shop": ("dinner", None),
    **{f"{x}_restaurant": ("dinner", None) for x in _DINNER_PLAIN},
    # 咖啡
    "cafe": ("cafe", "咖啡馆"), "coffee_shop": ("cafe", "咖啡馆"), "coffee_stand": ("cafe", "咖啡馆"),
    "coffee_roastery": ("cafe", "咖啡馆"), "tea_house": ("cafe", "茶馆"),
    "breakfast_restaurant": ("cafe", "早午餐"), "brunch_restaurant": ("cafe", "早午餐"),
    "juice_shop": ("cafe", None), "acai_shop": ("cafe", None),
    # 甜品·面包
    "bakery": ("sweets", "面包店"), "bagel_shop": ("sweets", "面包店"),
    "cake_shop": ("sweets", "蛋糕店"), "pastry_shop": ("sweets", "蛋糕店"),
    "dessert_shop": ("sweets", "甜品店"), "dessert_restaurant": ("sweets", "甜品店"),
    "donut_shop": ("sweets", "甜品店"), "confectionery": ("sweets", "甜品店"),
    "candy_store": ("sweets", "甜品店"), "chocolate_shop": ("sweets", "甜品店"),
    "chocolate_factory": ("sweets", "甜品店"),
    "ice_cream_shop": ("sweets", "冰淇淋"),
    # 酒吧
    "bar": ("bar", "酒吧"), "cocktail_bar": ("bar", "酒吧"), "pub": ("bar", "酒吧"), "irish_pub": ("bar", "酒吧"),
    "sports_bar": ("bar", "酒吧"), "bar_and_grill": ("bar", "酒吧"), "hookah_bar": ("bar", "酒吧"),
    "wine_bar": ("bar", "红酒吧"), "winery": ("bar", "红酒吧"),
    "brewery": ("bar", "精酿"), "brewpub": ("bar", "精酿"), "beer_garden": ("bar", "精酿"),
    "lounge_bar": ("bar", "夜景酒廊"), "night_club": ("bar", None),
    # 电影
    "movie_theater": ("cinema", "电影院"),
    # 演出·Live
    "live_music_venue": ("live", "Live house"), "performing_arts_theater": ("live", "剧场"),
    "opera_house": ("live", "剧场"), "concert_hall": ("live", "音乐会"), "philharmonic_hall": ("live", "音乐会"),
    "amphitheatre": ("live", "演唱会"), "comedy_club": ("live", "落语·曲艺"), "auditorium": ("live", None),
    # 看展
    "art_museum": ("museum", "美术馆"), "museum": ("museum", "博物馆"), "history_museum": ("museum", "博物馆"),
    "art_gallery": ("museum", "画廊"), "planetarium": ("museum", "科学馆"), "cultural_center": ("museum", None),
    # 水族馆·动物园
    "aquarium": ("aquarium", "水族馆"), "zoo": ("aquarium", "动物园"), "wildlife_park": ("aquarium", "动物园"),
    "botanical_garden": ("aquarium", "植物园"),
    "cat_cafe": ("aquarium", "猫咖·动物咖啡"), "dog_cafe": ("aquarium", "猫咖·动物咖啡"),
    # 游乐园
    "amusement_park": ("amusement", "游乐园"), "water_park": ("amusement", "游乐园"),
    "roller_coaster": ("amusement", "游乐园"), "ferris_wheel": ("amusement", "摩天轮"),
    # 玩乐
    "karaoke": ("play", "卡拉OK"), "video_arcade": ("play", "游戏厅"), "amusement_center": ("play", "游戏厅"),
    "bowling_alley": ("play", "保龄球"), "miniature_golf_course": ("play", None),
    "go_karting_venue": ("play", None), "indoor_playground": ("play", None), "paintball_center": ("play", None),
    # 散步
    "plaza": ("walk", "街道"), "beach": ("walk", "海边"), "marina": ("walk", "海边"),
    "fishing_pier": ("walk", "海边"), "river": ("walk", "河边"),
    # 公园
    "park": ("park", "公园"), "city_park": ("park", "公园"), "state_park": ("park", "公园"),
    "national_park": ("park", "公园"), "garden": ("park", "庭园"), "picnic_ground": ("park", None),
    "hiking_area": ("park", None), "nature_preserve": ("park", None),
    # 展望台
    "observation_deck": ("viewpoint", "展望台"), "scenic_spot": ("viewpoint", None),
    "mountain_peak": ("viewpoint", None),
    # 神社
    "shinto_shrine": ("shrine", "神社"), "buddhist_temple": ("shrine", "寺庙"), "hindu_temple": ("shrine", "寺庙"),
    "church": ("shrine", "教会"), "mosque": ("shrine", None), "synagogue": ("shrine", None),
    # 买东西
    "shopping_mall": ("shopping", "商场"), "department_store": ("shopping", "商场"),
    "clothing_store": ("shopping", "服装"), "womens_clothing_store": ("shopping", "服装"),
    "shoe_store": ("shopping", "服装"), "sportswear_store": ("shopping", "服装"),
    "book_store": ("shopping", "书店"), "florist": ("shopping", "花店"),
    "gift_shop": ("shopping", "杂货"), "home_goods_store": ("shopping", "杂货"),
    "discount_store": ("shopping", "杂货"), "general_store": ("shopping", "杂货"),
    "supermarket": ("shopping", "超市"), "grocery_store": ("shopping", "超市"),
    "asian_grocery_store": ("shopping", "超市"), "discount_supermarket": ("shopping", "超市"),
    "hypermarket": ("shopping", "超市"),
    "store": ("shopping", None), "market": ("shopping", None), "flea_market": ("shopping", None),
    "farmers_market": ("shopping", None), "jewelry_store": ("shopping", None),
    "cosmetics_store": ("shopping", None), "electronics_store": ("shopping", None),
    "toy_store": ("shopping", None), "thrift_store": ("shopping", None), "tea_store": ("shopping", None),
    "pet_store": ("shopping", None), "convenience_store": ("shopping", None),
    # 温泉
    "public_bath": ("onsen", "钱汤"), "sauna": ("onsen", "桑拿"), "spa": ("onsen", "SPA"),
    "massage_spa": ("onsen", "SPA"),
    # 住宿
    "hotel": ("stay", "酒店"), "resort_hotel": ("stay", "酒店"), "extended_stay_hotel": ("stay", "酒店"),
    "motel": ("stay", "酒店"), "lodging": ("stay", "酒店"),
    "japanese_inn": ("stay", "旅馆"), "budget_japanese_inn": ("stay", "旅馆"), "inn": ("stay", "旅馆"),
    "bed_and_breakfast": ("stay", "民宿"), "guest_house": ("stay", "民宿"), "hostel": ("stay", "民宿"),
    "private_guest_room": ("stay", "民宿"), "farmstay": ("stay", "民宿"), "cottage": ("stay", "民宿"),
}
# 笼统类型:排在第一位时,types 里同大类、有细类的更具体类型优先(餐馆 → 拉面)
_WEAK = frozenset({"restaurant", "cafe", "bar", "store", "transit_station", "transit_stop", "lodging",
                   "museum", "park", "market"})


def classify(primary_type: str | None, types=None) -> tuple[str | None, str | None]:
    """谷歌 primaryType / types → (大类, 细类)。先看 primaryType,再按 types 的顺序;都对不上 = (None, None)。"""
    order = [t for t in [primary_type, *(types or [])] if isinstance(t, str) and t]
    hits = [(t, GOOGLE_TYPE_MAP[t]) for t in order if t in GOOGLE_TYPE_MAP]
    if not hits:
        return None, None
    t0, (kind, sub) = hits[0]
    if t0 in _WEAK or sub is None:
        # 笼统的排第一(餐馆)或自己没细类(日本料理):同大类里更具体、带细类的优先(→ 拉面/寿司)
        for t, (k, s) in hits[1:]:
            if k == kind and s and t not in _WEAK:
                return k, s
    if sub is None:                                # 没有更具体的:同大类笼统类型的细类也行(日本料理 → 餐馆)
        for t, (k, s) in hits[1:]:
            if k == kind and s:
                return k, s
    return kind, sub


classify_google = classify


# ── 高德 POI typecode → (大类, 细类) ───────────────────────────────────────────────────
# 查法：先查 6 位完整编码；没登记再退到前 4 位 + "00"，再退到前 2 位 + "0000"（编码按两位一层分级）。
# 值为 None = 明确不分类且不再回退（如火车站里的售票处、超市大类下的药妆店）。
# 行尾注释是本仓自己的说明：这类编码在约会里算哪种站、为什么这样归。
AMAP_TYPE_MAP: dict[str, tuple[str, str | None] | None] = {
    # 05 段：吃饭、咖啡、甜品
    "050000": ("dinner", None),                                # 吃饭的地方（这一大段编码的兜底）
    "050100": ("dinner", "中餐"),                               # 中式餐馆（各菜系子码回退到这里）
    "050200": ("dinner", "餐馆"),                               # 外国菜餐馆
    "050201": ("dinner", "餐馆"),                               # 西式餐馆，不分菜系
    "050202": ("dinner", None),                                # 日式餐馆：太宽，不猜细类
    "050203": ("dinner", "韩餐"),                               # 韩式餐馆
    "050204": ("dinner", "法餐"),                               # 法式餐馆
    "050205": ("dinner", "意大利菜"),                            # 意式餐馆
    **{f"0502{n:02d}": ("dinner", None) for n in range(6, 18)},  # 其余各国菜系子码：只知道是吃饭，不猜细类
    "050300": ("dinner", None),                                # 快餐
    "050303": ("dinner", "意大利菜"),                            # 连锁比萨快餐
    "050400": ("cafe", None),                                  # 轻食小坐的地方
    "050500": ("cafe", "咖啡馆"),                               # 咖啡（连锁子码回退到这里）
    "050600": ("cafe", "茶馆"),                                 # 喝茶的地方
    "050700": ("sweets", "冰淇淋"),                              # 冷饮
    "050800": ("sweets", "面包店"),                              # 面包糕点
    "050900": ("sweets", "甜品店"),                              # 甜品
    # 06 段：买东西
    "060000": ("shopping", None),                              # 买东西的地方（这一大段编码的兜底）
    "060100": ("shopping", "商场"),                             # 商场与购物中心
    "060200": ("shopping", None),                              # 便利店：去买东西，但不是一站约会的细类
    "060300": ("shopping", None),                              # 电器数码卖场
    "060400": ("shopping", "超市"),                             # 超市
    "060411": ("shopping", None),                              # 药妆连锁：不回退成超市
    "060415": ("shopping", None),                              # 药妆连锁：不回退成超市
    "060500": ("shopping", None),                              # 花鸟市场
    "060501": ("shopping", "花店"),                             # 卖花的地方
    "060600": None,                                            # 建材家居：不当约会的一站
    "060700": ("shopping", None),                              # 综合市场
    "060800": ("shopping", "文具"),                             # 文具
    "060900": ("shopping", None),                              # 运动用品
    "061000": ("walk", "商店街"),                               # 步行街、商业街：算散步
    "061100": ("shopping", "服装"),                             # 服装鞋包
    "061200": ("shopping", None),                              # 各类专卖店
    "061204": ("shopping", "眼镜店"),                            # 眼镜
    "061205": ("shopping", "书店"),                             # 书店
    "061209": ("shopping", "杂货"),                             # 礼品小物
    "061300": None,                                            # 拍卖、典当：不当约会的一站
    "061400": ("shopping", None),                              # 个人用品、化妆品
    # 07 段：只用到洗浴按摩
    "071400": ("onsen", None),                                 # 洗浴按摩
    # 08 段：玩乐、演出、度假
    "080300": ("play", None),                                  # 娱乐场所（这一段的兜底）
    "080301": ("bar", None),                                   # 夜场：归酒吧，不猜细类
    "080302": ("play", "卡拉OK"),                               # 唱歌的包间
    "080303": ("bar", None),                                   # 舞厅：归酒吧，不猜细类
    "080304": ("bar", "酒吧"),                                  # 酒吧
    "080305": ("play", "游戏厅"),                               # 游戏厅
    "080306": ("play", None),                                  # 棋牌：归玩乐，不猜细类
    "080307": None,                                            # 博彩：不当约会的一站
    "080308": None,                                            # 网吧：不当约会的一站
    "080400": None,                                            # 度假疗养（太宽，不猜）
    "080401": ("stay", "酒店"),                                 # 度假村：算住宿
    "080500": ("play", None),                                  # 休闲场所（这一段的兜底）
    "080501": ("amusement", "游乐园"),                           # 游乐场
    "080504": ("park", None),                                  # 露营：算公园
    "080600": ("live", None),                                  # 演出场所（这一段的兜底）
    "080601": ("cinema", "电影院"),                              # 电影院
    "080602": ("live", "音乐会"),                               # 音乐厅
    "080603": ("live", "剧场"),                                 # 剧场
    # 10 段：住宿
    "100000": ("stay", None),                                  # 住宿（这一大段编码的兜底）
    "100100": ("stay", "酒店"),                                 # 酒店（各星级子码回退到这里）
    "100200": ("stay", "旅馆"),                                 # 旅馆
    "100201": ("stay", "民宿"),                                 # 青旅：算民宿
    # 11 段：公园、景点、宗教场所
    "110100": ("park", None),                                  # 公园与广场（这一段的兜底）
    "110101": ("park", "公园"),                                 # 公园
    "110102": ("aquarium", "动物园"),                            # 动物园
    "110103": ("aquarium", "植物园"),                            # 植物园
    "110104": ("aquarium", "水族馆"),                            # 水族馆
    "110105": ("walk", "街道"),                                 # 城市广场：算散步
    "110106": ("park", None),                                  # 公园里的设施
    "110200": None,                                            # 景点：太宽，不猜
    "110204": ("museum", None),                                # 纪念馆：归看展
    "110205": ("shrine", "寺庙"),                               # 寺庙
    "110206": ("shrine", "教会"),                               # 教堂
    "110207": ("shrine", None),                                # 清真寺：归宗教场所，不猜细类
    "110208": ("walk", "海边"),                                 # 海滩：算散步
    "110209": ("viewpoint", None),                             # 看风景的地方
    # 14 段：展馆
    "140100": ("museum", "博物馆"),                              # 博物馆
    "140200": ("museum", None),                                # 展览场馆
    "140201": None,                                            # 室内展位：不当一站
    "140400": ("museum", "美术馆"),                              # 美术馆
    "140600": ("museum", "科学馆"),                              # 科技馆
    "140700": ("museum", "科学馆"),                              # 天文馆：归科学馆
    "140800": ("museum", None),                                # 文化宫：归看展，不猜细类
    # 15 段：交通
    "150200": ("train", "车站"),                                # 火车站
    "150201": None, "150205": None, "150206": None, "150207": None,   # 火车站里的附属设施与窗口：
    "150208": None, "150209": None, "150210": None,                   # 不当集合点，也不回退成火车站
    "150400": ("train", "巴士站"),                               # 长途汽车站
    "150500": ("train", "地铁站"),                               # 地铁站（出入口子码回退到这里）
    "150600": ("train", "车站"),                                # 轻轨站
    "150700": ("train", "巴士站"),                               # 公交站
    "150705": ("train", "车站"),                                # 电车站
}


def classify_amap(typecode: str | None) -> tuple[str | None, str | None]:
    """高德 typecode（可能是 "050117|050100" 这样多个）→ (大类, 细类)。按顺序取第一个对得上的。"""
    for code in str(typecode or "").replace(";", "|").split("|"):
        code = code.strip()
        if len(code) != 6 or not code.isdigit():
            continue
        for key in (code, code[:4] + "00", code[:2] + "0000"):
            if key in AMAP_TYPE_MAP:
                hit = AMAP_TYPE_MAP[key]
                if hit is not None:
                    return hit
                break                                   # 明确不分类：这一个编码到此为止
    return None, None


# ── OSM 主标签（Nominatim class/type）→ (大类, 细类) ────────────────────────────────────
OSM_TYPE_MAP: dict[tuple[str, str], tuple[str, str | None]] = {
    # 集合
    ("railway", "station"): ("train", "车站"), ("railway", "halt"): ("train", "车站"),
    ("railway", "tram_stop"): ("train", "车站"), ("public_transport", "station"): ("train", "车站"),
    ("railway", "subway_entrance"): ("train", "地铁站"),
    ("highway", "bus_stop"): ("train", "巴士站"), ("amenity", "bus_station"): ("train", "巴士站"),
    # 晚餐
    ("amenity", "restaurant"): ("dinner", "餐馆"), ("amenity", "fast_food"): ("dinner", None),
    ("amenity", "food_court"): ("dinner", None),
    # 咖啡
    ("amenity", "cafe"): ("cafe", "咖啡馆"), ("shop", "coffee"): ("cafe", "咖啡馆"),
    # 甜品·面包
    ("shop", "bakery"): ("sweets", "面包店"), ("shop", "pastry"): ("sweets", "蛋糕店"),
    ("shop", "confectionery"): ("sweets", "甜品店"), ("shop", "chocolate"): ("sweets", "甜品店"),
    ("amenity", "ice_cream"): ("sweets", "冰淇淋"), ("shop", "ice_cream"): ("sweets", "冰淇淋"),
    # 酒吧
    ("amenity", "bar"): ("bar", "酒吧"), ("amenity", "pub"): ("bar", "酒吧"),
    ("amenity", "biergarten"): ("bar", "精酿"), ("craft", "brewery"): ("bar", "精酿"),
    ("amenity", "nightclub"): ("bar", None),
    # 电影
    ("amenity", "cinema"): ("cinema", "电影院"),
    # 演出·Live
    ("amenity", "theatre"): ("live", "剧场"), ("amenity", "concert_hall"): ("live", "音乐会"),
    ("amenity", "events_venue"): ("live", None),
    # 看展
    ("tourism", "museum"): ("museum", "博物馆"), ("tourism", "gallery"): ("museum", "画廊"),
    ("amenity", "arts_centre"): ("museum", None), ("amenity", "planetarium"): ("museum", "科学馆"),
    # 水族馆·动物园
    ("tourism", "aquarium"): ("aquarium", "水族馆"), ("tourism", "zoo"): ("aquarium", "动物园"),
    ("leisure", "garden_botanical"): ("aquarium", "植物园"),
    # 游乐园
    ("tourism", "theme_park"): ("amusement", "主题乐园"), ("leisure", "water_park"): ("amusement", "游乐园"),
    # 玩乐
    ("amenity", "karaoke_box"): ("play", "卡拉OK"), ("leisure", "amusement_arcade"): ("play", "游戏厅"),
    ("leisure", "bowling_alley"): ("play", "保龄球"), ("leisure", "escape_game"): ("play", "密室逃脱"),
    ("leisure", "miniature_golf"): ("play", None),
    # 散步
    ("place", "square"): ("walk", "街道"), ("natural", "beach"): ("walk", "海边"),
    ("leisure", "beach_resort"): ("walk", "海边"), ("leisure", "marina"): ("walk", "海边"),
    ("waterway", "river"): ("walk", "河边"), ("waterway", "canal"): ("walk", "河边"),
    # 公园
    ("leisure", "park"): ("park", "公园"), ("leisure", "garden"): ("park", "庭园"),
    ("leisure", "nature_reserve"): ("park", None), ("tourism", "picnic_site"): ("park", None),
    ("tourism", "camp_site"): ("park", None),
    # 展望台
    ("tourism", "viewpoint"): ("viewpoint", None), ("natural", "peak"): ("viewpoint", None),
    # 神社（宗教场所，具体宗教看 religion 标签，Nominatim 不给，只到大类）
    ("amenity", "place_of_worship"): ("shrine", None),
    # 买东西
    ("shop", "mall"): ("shopping", "商场"), ("shop", "department_store"): ("shopping", "商场"),
    ("shop", "clothes"): ("shopping", "服装"), ("shop", "shoes"): ("shopping", "服装"),
    ("shop", "boutique"): ("shopping", "服装"), ("shop", "optician"): ("shopping", "眼镜店"),
    ("shop", "books"): ("shopping", "书店"), ("shop", "stationery"): ("shopping", "文具"),
    ("shop", "gift"): ("shopping", "杂货"), ("shop", "variety_store"): ("shopping", "杂货"),
    ("shop", "houseware"): ("shopping", "杂货"), ("shop", "florist"): ("shopping", "花店"),
    ("shop", "supermarket"): ("shopping", "超市"), ("shop", "greengrocer"): ("shopping", "超市"),
    ("amenity", "marketplace"): ("shopping", None),
    # 温泉
    ("natural", "hot_spring"): ("onsen", "温泉"), ("amenity", "public_bath"): ("onsen", "钱汤"),
    ("leisure", "sauna"): ("onsen", "桑拿"), ("shop", "massage"): ("onsen", "SPA"),
    # 住宿
    ("tourism", "hotel"): ("stay", "酒店"), ("tourism", "motel"): ("stay", "酒店"),
    ("tourism", "hostel"): ("stay", "民宿"), ("tourism", "guest_house"): ("stay", "民宿"),
    ("tourism", "apartment"): ("stay", "民宿"), ("tourism", "chalet"): ("stay", "民宿"),
}
# 整个 class 的兜底（只对 shop：任何商店至少是「买东西」）
_OSM_CLASS_FALLBACK: dict[str, tuple[str, str | None]] = {"shop": ("shopping", None)}


def classify_osm(cls: str | None, typ: str | None) -> tuple[str | None, str | None]:
    """OSM 主标签 class/type → (大类, 细类)。"""
    if not cls:
        return None, None
    hit = OSM_TYPE_MAP.get((cls, typ or ""))
    if hit:
        return hit
    return _OSM_CLASS_FALLBACK.get(cls, (None, None))

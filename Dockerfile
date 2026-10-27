# syntax=docker/dockerfile:1
# Ephemera 容器：VPS 或任意 Docker 主机。
# 数据（数据库、照片、生成的画、地点缓存）与底图库都在持久卷 /data 里；镜像里不含任何口令或钥匙。
# 口令与钥匙只经 -e / --env-file 在运行时传入。

# ── 第一阶段：构建网页包（web/ → web/dist，基础路径 /app）────────────────────────
# react-native 0.81 / metro 要 Node 20.19.4 以上（见 web/package-lock.json）；这里用 Node 22 LTS
FROM node:22-bookworm-slim AS web
WORKDIR /web
ENV CI=1 EXPO_NO_TELEMETRY=1 EPHEMERA_WEB_BASE=/app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── 第二阶段：把引擎和网页包打成一个 wheel（网页包在包数据位置 ephemera_date/web/）──
FROM python:3.12-slim AS wheel
WORKDIR /src
COPY pyproject.toml setup.py MANIFEST.in README.md LICENSE LICENSE-CONTENT LICENSING.md NOTICE ./
COPY scripts/bundle_web.py ./scripts/
COPY src ./src
COPY --from=web /web/dist ./src/ephemera_date/web
# setup.py 见到网页包已在位就只核对（/app 基础路径、带哈希的文件名），不再要 Node
RUN pip wheel --no-cache-dir --no-deps -w /wheels . \
    && python -c "import zipfile,glob,sys; n=zipfile.ZipFile(glob.glob('/wheels/*.whl')[0]).namelist(); sys.exit(0 if 'ephemera_date/web/index.html' in n and any(x.startswith('ephemera_date/web/_expo/') for x in n) else 'wheel has no pages')"

# ── 最终镜像：只装 wheel，不含 Node、node_modules，也不留第二份网页包 ───────────
FROM python:3.12-slim
WORKDIR /app
COPY README.md LICENSE LICENSE-CONTENT LICENSING.md NOTICE ./
COPY scripts ./scripts
# [map-build] = pyosmium + pyshp，容器里也能跑 scripts/build_basemap.py 建底图（pyosmium 运行时要 libexpat）
RUN --mount=type=bind,from=wheel,source=/wheels,target=/wheels \
    apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "$(ls /wheels/ephemera_date-*.whl)[map-build]" \
    && useradd --create-home ephemera && mkdir /data && chown ephemera /data
USER ephemera
ENV EPHEMERA_DATA_DIR=/data \
    EPHEMERA_MAP_DIR=/data/maps
VOLUME ["/data"]
EXPOSE 8791
# 监听 0.0.0.0 时必须同时设 EPHEMERA_HER_TOKEN 与 EPHEMERA_AI_TOKEN，否则服务拒绝启动
# 页面在 http://<主机>:8791/app/；接口 /api、/context、/mcp 照旧
CMD ["ephemera-date", "serve", "--host", "0.0.0.0", "--port", "8791"]

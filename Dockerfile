FROM jlesage/baseimage-gui:debian-bookworm-v4.11.3

ARG VERSION=1.2.0

ENV APP_NAME=Chat2API \
    APP_VERSION=${VERSION} \
    TZ=Asia/Shanghai \
    DISPLAY_WIDTH=1920 \
    DISPLAY_HEIGHT=1080 \
    KEEP_APP_RUNNING=1 \
    USER_ID=0 \
    GROUP_ID=0

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
        libatspi2.0-0 libdrm2 libgbm1 libasound2 \
        libglib2.0-0 libxrandr2 libcups2 \
        libxdamage1 libxfixes3 libxcomposite1 libxkbcommon0 \
        libx11-xcb1 libxcb-dri3-0 libxcb1 libxshmfence1 \
        libatk1.0-0 libatk-bridge2.0-0 \
        fonts-liberation ca-certificates xdotool \
    && rm -rf /var/lib/apt/lists/*

# Install CJK font support
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-wqy-zenhei fonts-wqy-microhei locales \
    && echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV LANGUAGE=zh_CN:zh \
    LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8

# Copy pre-built application
COPY app/dist/app /app

# Copy startup script and desktop integration
COPY docker/startapp.sh /startapp.sh
RUN chmod +x /startapp.sh

RUN mkdir -p /etc/xdg/openbox
COPY docker/openbox-autostart /etc/xdg/openbox/autostart

COPY docker/icons /opt/noVNC/app/images/icons

# Create data directories
RUN mkdir -p /root/.chat2api /root/.pki/nssdb

VOLUME ["/root/.chat2api"]

EXPOSE 5800 5900 8080

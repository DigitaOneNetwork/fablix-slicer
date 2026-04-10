FROM ghcr.io/afkfelix/orca-slicer-api:v0.3.0-orca2.3.1-amd64

ARG SLICER_BUILD_COMMIT=unknown
ARG SLICER_BUILD_DATE=unknown

# xvfb-run installieren (für headless OrcaSlicer)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Node.js Service-Code installieren
WORKDIR /service
COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js .

ENV PORT=3000
ENV ORCA_CLI_PATH=/app/squashfs-root/AppRun
ENV ORCA_PROFILES_PATH=/app/squashfs-root/resources/profiles/BBL
ENV XVFB_RUN=xvfb-run
ENV LC_ALL=C.UTF-8
ENV SLICER_BUILD_COMMIT=$SLICER_BUILD_COMMIT
ENV SLICER_BUILD_DATE=$SLICER_BUILD_DATE

EXPOSE 3000

CMD ["node", "index.js"]

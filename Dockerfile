FROM ghcr.io/afkfelix/orca-slicer-api:v0.3.0-orca2.3.1-amd64

ARG SLICER_BUILD_COMMIT=unknown
ARG SLICER_BUILD_DATE=unknown
ARG ORCA_PROFILE_TAG=v2.3.2

ENV ORCA_PROFILES_PATH=/app/squashfs-root/resources/profiles/BBL

# xvfb-run installieren (für headless OrcaSlicer)
RUN apt-get update && apt-get install -y ca-certificates curl xvfb && rm -rf /var/lib/apt/lists/*

# OrcaSlicer 2.3.1 ist das verfügbare Basis-Image; H2S-Profile liegen ab 2.3.2 vor.
RUN set -eux; \
    base="https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/${ORCA_PROFILE_TAG}/resources/profiles/BBL"; \
    curl -fsSL "$base/machine/Bambu%20Lab%20H2S%200.4%20nozzle.json" \
      -o "$ORCA_PROFILES_PATH/machine/Bambu Lab H2S 0.4 nozzle.json"; \
    curl -fsSL "$base/process/0.12mm%20High%20Quality%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/process/0.12mm High Quality @BBL H2S.json"; \
    curl -fsSL "$base/process/0.20mm%20Standard%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/process/0.20mm Standard @BBL H2S.json"; \
    curl -fsSL "$base/process/0.24mm%20Standard%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/process/0.24mm Standard @BBL H2S.json"; \
    curl -fsSL "$base/filament/Bambu%20PLA%20Basic%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Bambu PLA Basic @BBL H2S.json"; \
    curl -fsSL "$base/filament/Bambu%20PETG%20Basic%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Bambu PETG Basic @BBL H2S.json"; \
    curl -fsSL "$base/filament/Bambu%20ABS%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Bambu ABS @BBL H2S.json"; \
    curl -fsSL "$base/filament/Bambu%20TPU%2095A%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Bambu TPU 95A @BBL H2S.json"; \
    curl -fsSL "$base/filament/Bambu%20PLA-CF%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Bambu PLA-CF @BBL H2S.json"; \
    curl -fsSL "$base/filament/Generic%20PETG-CF%20%40BBL%20H2S.json" \
      -o "$ORCA_PROFILES_PATH/filament/Generic PETG-CF @BBL H2S.json"

# Node.js Service-Code installieren
WORKDIR /service
COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js .

ENV PORT=3000
ENV ORCA_CLI_PATH=/app/squashfs-root/AppRun
ENV XVFB_RUN=xvfb-run
ENV LC_ALL=C.UTF-8
ENV SLICER_BUILD_COMMIT=$SLICER_BUILD_COMMIT
ENV SLICER_BUILD_DATE=$SLICER_BUILD_DATE

EXPOSE 3000

CMD ["node", "index.js"]

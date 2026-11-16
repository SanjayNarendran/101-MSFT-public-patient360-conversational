# The Cohort Discovery chat relay (server.py), built in Azure by scripts/23_discovery_chat.py.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    COPILOT_CLI_EXTRACT_DIR=/opt/copilot-runtime \
    COPILOT_WORK_DIR=/home/relay/work \
    PORT=8080

RUN useradd --create-home --uid 10001 relay
WORKDIR /app
COPY requirements.txt .
# The Copilot runtime is downloaded at build time so the container starts without fetching it.
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m copilot download-runtime \
    && chown -R relay /opt/copilot-runtime
COPY server.py tools.json ./

USER relay
EXPOSE 8080
CMD ["python", "server.py"]

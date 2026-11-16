# Patient 360's Ask relay (server.py with RELAY=1), built in Azure by scripts/28_patient360_chat.py.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    COPILOT_CLI_EXTRACT_DIR=/opt/copilot-runtime \
    COPILOT_WORK_DIR=/home/relay/work \
    RELAY=1 \
    PORT=8080

RUN useradd --create-home --uid 10001 relay
WORKDIR /app
COPY requirements.txt .
# The Copilot runtime is downloaded at build time so the container starts without fetching it.
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m copilot download-runtime \
    && chown -R relay /opt/copilot-runtime
COPY server.py tools.py rules.py ./

USER relay
EXPOSE 8080
CMD ["python", "server.py"]

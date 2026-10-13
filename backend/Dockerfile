FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1
COPY requirements.txt requirements-lock.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --uid 10001 --create-home matrix && mkdir -p /app/data && chown -R matrix:matrix /app/data
USER matrix
ENV HOST=0.0.0.0 PORT=4174 DATA_DIR=/app/data/work/grey
EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4174/api/health',timeout=3)" || exit 1
CMD ["python", "run.py", "server"]

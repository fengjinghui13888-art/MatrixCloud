FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/matrix-maintenance/runtime
COPY requirements.txt requirements-lock.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tools /opt/matrix-maintenance/trusted
COPY run.py ./
ENV MAINTENANCE_CONFIG=/etc/matrix-maintenance/config.json PYTHONUNBUFFERED=1
CMD ["python", "run.py", "maintenance"]

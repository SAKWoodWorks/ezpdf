FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends -y qpdf ghostscript poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home app

WORKDIR /app
# Bare `pytest` (a console script) does not put the working directory on
# sys.path; PYTHONPATH keeps the documented `pytest -q` invocation runnable.
ENV PYTHONPATH=/app
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY --chown=app:app app ./app
COPY --chown=app:app tests ./tests
RUN mkdir -p /jobs && chown -R app:app /app /jobs
USER app

CMD ["python", "-m", "app.worker"]

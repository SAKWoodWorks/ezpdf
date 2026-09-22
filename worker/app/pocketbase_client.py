"""Server-only PocketBase metadata access; authentication stays in memory."""

import re

import httpx


class PocketBaseClient:
    def __init__(self, url: str, email: str, password: str, *, transport=None):
        if not email or not password:
            raise ValueError("PocketBase superuser credentials are required")
        self._email = email
        self._password = password
        self._token = None
        self._http = httpx.Client(base_url=url.rstrip("/"), timeout=30, transport=transport)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self._http.close()
        self._token = None

    def _authenticate(self):
        response = self._http.post(
            "/api/collections/_superusers/auth-with-password",
            json={"identity": self._email, "password": self._password},
        )
        response.raise_for_status()
        self._token = response.json()["token"]

    def _request(self, method, path, **kwargs):
        if self._token is None:
            self._authenticate()
        response = self._http.request(method, path, headers={"Authorization": self._token}, **kwargs)
        if response.status_code == 401:
            self._authenticate()
            response = self._http.request(method, path, headers={"Authorization": self._token}, **kwargs)
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _record_path(record_id):
        if not isinstance(record_id, str) or not re.fullmatch(r"[a-zA-Z0-9]{15}", record_id):
            raise ValueError("invalid PocketBase record ID")
        return f"/api/collections/jobs/records/{record_id}"

    def get_job(self, record_id):
        return self._request("GET", self._record_path(record_id))

    def update_job(self, record_id, **changes):
        return self._request("PATCH", self._record_path(record_id), json=changes)

    def list_jobs(self, status=None):
        records = []
        page = 1
        while True:
            params = {"page": page, "perPage": 200, "sort": "id"}
            if status is not None:
                if status not in {"queued", "processing", "ready", "failed", "downloaded", "expired"}:
                    raise ValueError("invalid job status")
                params["filter"] = f'status = "{status}"'
            data = self._request("GET", "/api/collections/jobs/records", params=params)
            records.extend(data["items"])
            if page >= data["totalPages"]:
                return records
            page += 1

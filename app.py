import json
import time
import secrets
from typing import Dict, Any, List, Generator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import (
    RedirectResponse,
    JSONResponse,
    StreamingResponse,
    HTMLResponse,
)
from fastapi.middleware.cors import CORSMiddleware

import google.auth.transport.requests
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

import requests


CONFIG = json.loads(Path("CONFIG.json").read_text())
SESSION = (p := CONFIG.get("session_cache")) and json.loads(Path(p).read_text()) or {}

SCOPES = [
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive.photos.readonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
]
REDIRECT_PATH = "/api/oauth2callback"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    allow_origins=[CONFIG["domain"]],
)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def read_index():
    with open("index.html", "r", encoding="utf-8") as file:
        html_content = file.read()
    return html_content


def set_sid_cookie(resp, sid: str):
    resp.set_cookie("sid", sid, httponly=True, secure=False, samesite="lax")


def ensure_sid(req: Request):
    sid = req.cookies.get("sid")
    if not sid or sid not in SESSION:
        sid = secrets.token_urlsafe(24)
        SESSION[sid] = {}
    return sid


def get_creds(sid: str) -> Credentials | None:
    data = SESSION.get(sid) or {}
    raw = data.get("creds")
    if not raw:
        return None
    creds = Credentials.from_authorized_user_info(json.loads(raw))
    if not creds.valid and creds.expired and creds.refresh_token:
        creds.refresh(google.auth.transport.requests.Request())
        SESSION[sid]["creds"] = creds.to_json()
    return creds


def get_redirect_uri(request: Request):
    host = (
        CONFIG.get("domain")
        or request.headers.get("x-forwarded-host")
        or request.headers.get("host")
    )
    return f"https://{host}{REDIRECT_PATH}"


@app.get("/api/login")
def login(request: Request):
    sid = ensure_sid(request)
    redirect_uri = get_redirect_uri(request)
    flow = Flow.from_client_secrets_file(
        CONFIG["credentials"], scopes=SCOPES, redirect_uri=redirect_uri
    )
    auth_url, state = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent"
    )
    SESSION[sid]["state"] = state
    resp = RedirectResponse(auth_url, status_code=302)
    set_sid_cookie(resp, sid)
    return resp


@app.get(REDIRECT_PATH)
def oauth2callback(request: Request):
    sid = request.cookies.get("sid")
    if not sid or sid not in SESSION:
        return JSONResponse({"error": "no session"}, status_code=400)
    redirect_uri = get_redirect_uri(request)

    state = SESSION[sid].get("state")
    flow = Flow.from_client_secrets_file(
        CONFIG["credentials"],
        scopes=SCOPES,
        redirect_uri=redirect_uri,
        state=state,
    )
    flow.fetch_token(authorization_response=str(request.url))
    creds = flow.credentials
    SESSION[sid]["creds"] = creds.to_json()
    origin = f"https://{CONFIG['domain']}"
    (p := CONFIG.get("session_cache")) and Path(p).write_text(json.dumps(SESSION))
    return RedirectResponse(origin, status_code=302)


@app.get("/api/me")
def me(request: Request):
    sid = request.cookies.get("sid")
    if sid in SESSION and (userinfo := SESSION[sid].get("userinfo")) is not None:
        return JSONResponse(userinfo)

    creds = get_creds(sid) if sid else None
    if not creds:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    r = requests.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {creds.token}"},
        timeout=30,
    )
    r.raise_for_status()
    info = r.json()
    userinfo = {
        "name": info.get("name") or info.get("email") or "Anonymous",
        "picture": info.get("picture"),
    }
    SESSION[sid]["userinfo"] = userinfo
    (p := CONFIG.get("session_cache")) and Path(p).write_text(json.dumps(SESSION))
    return JSONResponse(userinfo)


@app.post("/api/logout")
def logout(request: Request):
    sid = request.cookies.get("sid")
    if sid and sid in SESSION:
        SESSION.pop(sid, None)
    response = JSONResponse({"ok": True})
    response.delete_cookie("sid")
    return response


def authed_get(creds: Credentials, url: str, params: Dict[str, Any] | None = None):
    headers = {"Authorization": f"Bearer {creds.token}"}
    r = requests.get(url, headers=headers, params=params or {}, timeout=60)
    r.raise_for_status()
    return r.json()


def authed_post(creds: Credentials, url: str, body: Dict[str, Any] | None = None):
    headers = {
        "Authorization": f"Bearer {creds.token}",
        "Content-Type": "application/json",
    }
    r = requests.post(url, headers=headers, json=body or {}, timeout=60)
    r.raise_for_status()
    return r.json()


def iter_pages_get(
    creds: Credentials, url: str, items_key: str
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    page_token = ""
    while True:
        params = {"pageSize": 50}
        if page_token:
            params["pageToken"] = page_token
        data = authed_get(creds, url, params)
        items.extend(data.get(items_key, []))
        page_token = data.get("nextPageToken") or ""
        if not page_token:
            break
    return items


def list_albums(creds: Credentials) -> List[Dict[str, Any]]:
    return iter_pages_get(
        creds, "https://photoslibrary.googleapis.com/v1/albums", "albums"
    )


@app.get("/api/export-stream")
def export_stream(request: Request):
    sid = request.cookies.get("sid")
    creds = get_creds(sid) if sid else None
    if not creds:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    def gen() -> Generator[bytes, None, None]:
        start = time.time()
        albums = list_albums(creds) or []
        yield f'data: {{"type":"albums_count","count":{len(albums)}}}\n\n'.encode()

        result = {"albums": []}
        for a in albums:
            album_id = a.get("id")
            title = a.get("title") or ""
            total = int(a.get("mediaItemsCount") or 0)
            # announce album
            meta = {
                "id": album_id,
                "title": title,
                "mediaItemsCount": total,
                "items": [],
            }
            result["albums"].append(meta)
            announce = {
                "type": "album",
                "album": {"id": album_id, "title": title, "mediaItemsCount": total},
            }
            yield (
                "data: " + json.dumps(announce, ensure_ascii=False) + "\n\n"
            ).encode()

            # fetch media with progress
            next_page_token = ""
            loaded = 0
            while True:
                body = {"pageSize": 100, "albumId": album_id}
                if next_page_token:
                    body["pageToken"] = next_page_token
                data = authed_post(
                    creds,
                    "https://photoslibrary.googleapis.com/v1/mediaItems:search",
                    body,
                )
                chunk = data.get("mediaItems", []) or []
                meta["items"].extend(chunk)
                loaded += len(chunk)
                next_page_token = data.get("nextPageToken") or ""
                payload = {
                    "type": "progress",
                    "albumId": album_id,
                    "loaded": loaded,
                    "total": total or max(loaded, 1),
                    "items": chunk,
                }
                yield (
                    "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                ).encode()
                if not next_page_token:
                    break

        elapsed = round(time.time() - start, 2)
        yield (
            "data: "
            + json.dumps(
                {"type": "done", "elapsed": elapsed, "result": result},
                ensure_ascii=False,
            )
            + "\n\n"
        ).encode()

    return StreamingResponse(gen(), media_type="text/event-stream")

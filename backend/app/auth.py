"""Two auth schemes:

1. Desktop clients: static API key (header X-Device-Key), mapped to a location
   via DEVICE_API_KEYS env ("key:location_id,key2:location_id2").
2. Dashboard users: Supabase JWT in Authorization: Bearer <token>.
   In development (SUPABASE_JWT_SECRET empty) JWT check is skipped.
"""
import uuid

import jwt
from fastapi import Depends, Header, HTTPException

from .config import get_settings

settings = get_settings()


class DeviceContext:
    def __init__(self, location_id: uuid.UUID):
        self.location_id = location_id


class UserContext:
    def __init__(self, user_id: str, email: str | None = None):
        self.user_id = user_id
        self.email = email


async def require_device(x_device_key: str = Header(default="")) -> DeviceContext:
    key_map = settings.device_key_map()
    if not key_map:
        if settings.environment == "development":
            # Dev fallback: any non-empty key, location passed elsewhere.
            raise HTTPException(500, "DEVICE_API_KEYS is not configured")
        raise HTTPException(500, "DEVICE_API_KEYS is not configured")
    location_id = key_map.get(x_device_key)
    if not location_id:
        raise HTTPException(401, "Invalid device key")
    return DeviceContext(location_id=uuid.UUID(location_id))


async def require_user(authorization: str = Header(default="")) -> UserContext:
    if not settings.supabase_jwt_secret:
        if settings.environment == "development":
            return UserContext(user_id="dev", email="dev@local")
        raise HTTPException(500, "SUPABASE_JWT_SECRET is not configured")
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid token: {e}") from e
    return UserContext(user_id=payload.get("sub", ""), email=payload.get("email"))


RequireDevice = Depends(require_device)
RequireUser = Depends(require_user)

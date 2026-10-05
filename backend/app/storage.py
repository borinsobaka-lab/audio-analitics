"""S3-compatible object storage (Cloudflare R2)."""
import boto3
from botocore.config import Config

from .config import get_settings

settings = get_settings()


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url or None,
        aws_access_key_id=settings.s3_access_key_id or None,
        aws_secret_access_key=settings.s3_secret_access_key or None,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4"),
    )


def segment_key(day_recording_id: str, idx: int) -> str:
    return f"recordings/{day_recording_id}/seg_{idx:05d}.opus"


def merged_key(day_recording_id: str) -> str:
    return f"recordings/{day_recording_id}/merged.opus"


def transcript_key(day_recording_id: str) -> str:
    return f"recordings/{day_recording_id}/transcript.json"


def upload_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    s3_client().put_object(
        Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type
    )
    return key


def upload_file(key: str, path: str, content_type: str = "application/octet-stream") -> str:
    s3_client().upload_file(
        path, settings.s3_bucket, key, ExtraArgs={"ContentType": content_type}
    )
    return key


def download_file(key: str, path: str) -> str:
    s3_client().download_file(settings.s3_bucket, key, path)
    return path


def get_bytes(key: str) -> bytes:
    resp = s3_client().get_object(Bucket=settings.s3_bucket, Key=key)
    return resp["Body"].read()


def delete_prefix(prefix: str) -> int:
    """Delete every object under a prefix. Returns how many were removed."""
    client = s3_client()
    deleted = 0
    token: str | None = None
    while True:
        kwargs = {"Bucket": settings.s3_bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if keys:
            client.delete_objects(
                Bucket=settings.s3_bucket, Delete={"Objects": keys, "Quiet": True}
            )
            deleted += len(keys)
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    return deleted


def recording_prefix(day_recording_id: str) -> str:
    return f"recordings/{day_recording_id}/"


def presigned_get_url(key: str, ttl_s: int | None = None) -> str:
    return s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=ttl_s or settings.presigned_url_ttl_s,
    )

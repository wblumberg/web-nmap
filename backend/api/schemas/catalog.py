from typing import Optional, Dict, Any, List
from pydantic import BaseModel
from datetime import datetime

class CatalogEntry(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    type: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    metadata: Optional[Dict[str, Any]] = None

class CatalogResponse(BaseModel):
    catalog: List[CatalogEntry]

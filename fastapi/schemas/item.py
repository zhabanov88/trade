# fastapi/app/models/item.py
from pydantic import BaseModel

class Item(BaseModel):
    name: str
    price: float

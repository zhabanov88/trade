from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from db import get_db
from sqlalchemy import text
# from schemas.item import Item
from services.run_function import RunFunction

router = APIRouter()

# @router.post('/items/')
# async def create_item(item: Item):
#     return {'message': f'Создано {item.name} за {item.price} руб.'}

@router.get('/run-function/')
async def root(calls: str, db: Session = Depends(get_db)):
    runner = RunFunction(db=db)
    runner.prepare_functions(calls=calls)
    results = runner.run_functions()
    return {'result': results}

# Modelo de datos

SQLite en `habit.db`, dentro de `HABIT_DATA_DIR` (en Docker, el volumen `/app/data`). Las migraciones viven en `habit-api/Migrations`. Esta versión documenta lo que existe hoy; cada bloque del plan agrega sus tablas junto con su migración.

Toda tabla de datos personales lleva `UserId`. `HabitDb` aplica un filtro global por la persona de la petición, y con el login apagado esa persona es el usuario local (`Id = 1`, creado por la migración inicial).

```mermaid
erDiagram
    Users ||--o{ Books : "guarda"

    Users {
        INTEGER Id PK "NOT NULL"
        TEXT Username UK "NOT NULL, máx. 64"
        INTEGER IsAdmin "NOT NULL"
        TEXT TimeZone "NOT NULL, id IANA, máx. 64"
    }

    Books {
        INTEGER Id PK "NOT NULL"
        INTEGER UserId FK "NOT NULL"
        TEXT Title "NOT NULL, máx. 200"
        TEXT Author "NOT NULL, máx. 150"
        TEXT Isbn "máx. 13"
        INTEGER TotalPages
        INTEGER Page
        INTEGER Archived "NOT NULL"
        TEXT MetadataStatus "NOT NULL, Complete o Pending"
        TEXT CreatedAt "NOT NULL, UTC"
    }
```

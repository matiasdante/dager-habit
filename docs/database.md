# Modelo de datos

SQLite en `habit.db`, dentro de `HABIT_DATA_DIR` (en Docker, el volumen `/app/data`). Las migraciones viven en `habit-api/Migrations`. Esta versión documenta lo que existe hoy; cada bloque del plan agrega sus tablas junto con su migración.

Toda tabla de datos personales lleva `UserId`. `HabitDb` aplica un filtro global por la persona de la petición, y con el login apagado esa persona es el usuario local (`Id = 1`, creado por la migración inicial).

`MetadataStatus` es `Complete` cuando el libro tiene el total de páginas. Las portadas no están en la base: viven como archivos en `covers/<id>` dentro de `HABIT_DATA_DIR`.

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
        TEXT Isbn UK "ISBN-13, único por usuario"
        INTEGER TotalPages
        INTEGER Page
        TEXT Language "máx. 3"
        INTEGER PublicationYear
        TEXT Summary "máx. 1000"
        TEXT CoverType "tipo MIME de la portada en disco"
        INTEGER MetadataAttempts "NOT NULL, tope 5"
        INTEGER Archived "NOT NULL"
        TEXT MetadataStatus "NOT NULL, Complete o Pending"
        TEXT CreatedAt "NOT NULL, UTC"
    }
```

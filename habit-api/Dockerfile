# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS web-build
WORKDIR /source
COPY --from=web package.json package-lock.json ./
RUN npm ci --no-fund
COPY --from=web angular.json ngsw-config.json tsconfig.json tsconfig.app.json ./
COPY --from=web src ./src
COPY --from=web public ./public
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api-build
WORKDIR /source
COPY Habit.Api.csproj ./
RUN dotnet restore
COPY Program.cs AiProviders.cs BookCatalog.cs NotebookAccess.cs ./
RUN dotnet publish -c Release --no-restore -o /release /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
RUN mkdir -p /app/data && chown "${APP_UID}:0" /app/data
COPY --from=api-build /release .
COPY --from=web-build /source/dist/habit-web/browser ./wwwroot
ENV ASPNETCORE_HTTP_PORTS=8080 HABIT_WEB_ROOT=/app/wwwroot HABIT_QUOTA_PATH=/app/data/quota.log
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Habit.Api.dll"]

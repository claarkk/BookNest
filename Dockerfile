FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY LibraryManagement.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish LibraryManagement.csproj --configuration Release --no-restore --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_ENVIRONMENT=Production
ENV PORT=8080
ENV LIBRARY_DB_PATH=/var/data/library_management.db
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "LibraryManagement.dll"]

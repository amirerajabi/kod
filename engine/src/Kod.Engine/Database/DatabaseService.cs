using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Database;

/// <summary>How to reach a database: a full connection string, or the fields Kod builds one from.</summary>
public sealed record DbConnectionDto(string Kind, string? ConnectionString, string? Host, int? Port, string? Database, string? User, string? Password, string? File, string? Options);

public sealed record DbColumnDto(string Name, string Type, bool Nullable, bool PrimaryKey);

public sealed record DbTableDto(string Name, string Kind, IReadOnlyList<DbColumnDto> Columns);

public sealed record DbSchemaDto(string Name, IReadOnlyList<DbTableDto> Tables, IReadOnlyList<string> Routines);

public sealed record DbQueryRequest(DbConnectionDto Connection, string Sql, string? QueryId, int MaxRows = 500);

public sealed record DbResultDto(IReadOnlyList<string> Columns, IReadOnlyList<string> Types, IReadOnlyList<IReadOnlyList<string?>> Rows, bool Truncated, int RecordsAffected);

public sealed record DbQueryResultDto(IReadOnlyList<DbResultDto> Results, long ElapsedMs, IReadOnlyList<string> Messages, string? Error, int? ErrorLine);

public sealed record DiscoveredSourceDto(string Name, string Kind, string ConnectionString, string File);

/// <summary>
/// Kod's DataGrip: connections to SQL Server, PostgreSQL, MySQL / MariaDB and SQLite through their ADO.NET
/// providers, the schema tree, and a SQL console. Kod keeps no passwords: every request brings its connection.
/// </summary>
public sealed class DatabaseService(WorkspaceService workspace, ILogger<DatabaseService> log)
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> running = new();

    private static readonly string[] Kinds = ["sqlserver", "postgres", "mysql", "sqlite"];

    // ------------------------------------------------------------------ connections

    /// <summary>The connection string of a data source (EF Core scaffolding passes it to dotnet ef).</summary>
    internal static string ConnectionStringOf(DbConnectionDto c) => string.IsNullOrWhiteSpace(c.ConnectionString) ? Build(c) : c.ConnectionString!;

    private static DbConnection Create(DbConnectionDto c)
    {
        if (!Kinds.Contains(c.Kind)) throw new ArgumentException($"Unknown database kind '{c.Kind}'");
        var cs = ConnectionStringOf(c);
        return c.Kind switch
        {
            "sqlserver" => new Microsoft.Data.SqlClient.SqlConnection(cs),
            "postgres" => new Npgsql.NpgsqlConnection(cs),
            "mysql" => new MySqlConnector.MySqlConnection(cs),
            _ => new Microsoft.Data.Sqlite.SqliteConnection(cs),
        };
    }

    private static string Build(DbConnectionDto c)
    {
        DbConnectionStringBuilder b = c.Kind switch
        {
            "sqlserver" => new Microsoft.Data.SqlClient.SqlConnectionStringBuilder
            {
                DataSource = string.IsNullOrWhiteSpace(c.Host) ? "localhost" : c.Port is > 0 ? $"{c.Host},{c.Port}" : c.Host,
                InitialCatalog = c.Database ?? "",
                IntegratedSecurity = string.IsNullOrWhiteSpace(c.User),
                UserID = c.User ?? "",
                Password = c.Password ?? "",
                TrustServerCertificate = true,
                ConnectTimeout = 10,
                ApplicationName = "Kod",
            },
            "postgres" => new Npgsql.NpgsqlConnectionStringBuilder
            {
                Host = string.IsNullOrWhiteSpace(c.Host) ? "localhost" : c.Host,
                Port = c.Port is > 0 ? c.Port.Value : 5432,
                Database = c.Database,
                Username = c.User,
                Password = c.Password,
                Timeout = 10,
                ApplicationName = "Kod",
            },
            "mysql" => new MySqlConnector.MySqlConnectionStringBuilder
            {
                Server = string.IsNullOrWhiteSpace(c.Host) ? "localhost" : c.Host,
                Port = (uint)(c.Port is > 0 ? c.Port.Value : 3306),
                Database = c.Database ?? "",
                UserID = c.User ?? "",
                Password = c.Password ?? "",
                ConnectionTimeout = 10,
                AllowUserVariables = true,
            },
            _ => new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder { DataSource = c.File ?? c.Database ?? "" },
        };
        if (!string.IsNullOrWhiteSpace(c.Options))
            foreach (var part in c.Options.Split(';', StringSplitOptions.RemoveEmptyEntries))
                if (part.Split('=', 2) is [var k, var v]) b[k.Trim()] = v.Trim();
        return b.ConnectionString;
    }

    private static async Task<DbConnection> OpenAsync(DbConnectionDto c, CancellationToken ct)
    {
        if (c.Kind == "sqlite" && string.IsNullOrWhiteSpace(c.ConnectionString) && !System.IO.File.Exists(c.File ?? ""))
            throw new FileNotFoundException($"'{c.File}' does not exist");
        var conn = Create(c);
        try
        {
            await conn.OpenAsync(ct);
            return conn;
        }
        catch
        {
            await conn.DisposeAsync();
            throw;
        }
    }

    public async Task<object> TestAsync(DbConnectionDto c, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var conn = await OpenAsync(c, ct);
        return new { serverVersion = conn.ServerVersion, database = conn.Database, elapsedMs = sw.ElapsedMilliseconds };
    }

    // ------------------------------------------------------------------ schema

    public async Task<IReadOnlyList<DbSchemaDto>> SchemaAsync(DbConnectionDto c, CancellationToken ct)
    {
        await using var conn = await OpenAsync(c, ct);
        if (c.Kind == "sqlite") return [await SqliteSchemaAsync(conn, ct)];

        var schemaFilter = c.Kind switch
        {
            "sqlserver" => "t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')",
            "postgres" => "t.table_schema NOT IN ('pg_catalog', 'information_schema') AND t.table_schema NOT LIKE 'pg_toast%'",
            _ => "t.TABLE_SCHEMA = DATABASE()",
        };
        var tables = new Dictionary<(string Schema, string Table), (string Kind, List<DbColumnDto> Columns)>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = $"""
                SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.CHARACTER_MAXIMUM_LENGTH
                FROM INFORMATION_SCHEMA.TABLES t
                LEFT JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
                WHERE {schemaFilter}
                ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION
                """;
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var key = (r.GetString(0), r.GetString(1));
                if (!tables.TryGetValue(key, out var t)) tables[key] = t = (r.GetString(2).Contains("VIEW", StringComparison.OrdinalIgnoreCase) ? "view" : "table", []);
                if (r.IsDBNull(3)) continue;
                var type = r.GetString(4);
                if (!r.IsDBNull(6) && Convert.ToInt64(r.GetValue(6), CultureInfo.InvariantCulture) is var len and > 0) type += len >= int.MaxValue / 2 || len == -1 ? "(max)" : $"({len})";
                t.Columns.Add(new DbColumnDto(r.GetString(3), type, string.Equals(r.GetString(5), "YES", StringComparison.OrdinalIgnoreCase), false));
            }
        }

        // primary keys
        var pks = new HashSet<(string, string, string)>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                """;
            try
            {
                await using var r = await cmd.ExecuteReaderAsync(ct);
                while (await r.ReadAsync(ct)) pks.Add((r.GetString(0), r.GetString(1), r.GetString(2)));
            }
            catch (DbException ex)
            {
                log.LogDebug(ex, "Primary keys unavailable");
            }
        }

        var routines = new Dictionary<string, List<string>>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = c.Kind == "mysql"
                ? "SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME"
                : $"SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA', 'pg_catalog', 'information_schema') ORDER BY ROUTINE_NAME";
            try
            {
                await using var r = await cmd.ExecuteReaderAsync(ct);
                while (await r.ReadAsync(ct))
                {
                    if (!routines.TryGetValue(r.GetString(0), out var l)) routines[r.GetString(0)] = l = [];
                    l.Add(r.GetString(1));
                }
            }
            catch (DbException ex)
            {
                log.LogDebug(ex, "Routines unavailable");
            }
        }

        return tables.GroupBy(t => t.Key.Schema)
            .Select(g => new DbSchemaDto(
                g.Key,
                g.Select(t => new DbTableDto(t.Key.Table, t.Value.Kind, t.Value.Columns.Select(col => col with { PrimaryKey = pks.Contains((g.Key, t.Key.Table, col.Name)) }).ToList())).ToList(),
                routines.GetValueOrDefault(g.Key) ?? []))
            .Concat(routines.Keys.Where(s => tables.Keys.All(t => t.Schema != s)).Select(s => new DbSchemaDto(s, [], routines[s])))
            .OrderBy(s => s.Name is "dbo" or "public" ? 0 : 1).ThenBy(s => s.Name)
            .ToList();
    }

    private static async Task<DbSchemaDto> SqliteSchemaAsync(DbConnection conn, CancellationToken ct)
    {
        var names = new List<(string Name, string Kind)>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) names.Add((r.GetString(0), r.GetString(1)));
        }
        var tables = new List<DbTableDto>();
        foreach (var (name, kind) in names)
        {
            var cols = new List<DbColumnDto>();
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = $"PRAGMA table_info(\"{name.Replace("\"", "\"\"")}\")";
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) cols.Add(new DbColumnDto(r.GetString(1), r.IsDBNull(2) ? "" : r.GetString(2), r.GetInt64(3) == 0, r.GetInt64(5) > 0));
            tables.Add(new DbTableDto(name, kind, cols));
        }
        return new DbSchemaDto("main", tables, []);
    }

    // ------------------------------------------------------------------ queries

    /// <summary>SQL Server scripts are split at GO lines, like SSMS; other databases take the script as one batch.</summary>
    private static IReadOnlyList<(string Sql, int Line)> Batches(string kind, string sql)
    {
        if (kind != "sqlserver") return [(sql, 1)];
        var list = new List<(string, int)>();
        var sb = new StringBuilder();
        var start = 1;
        var n = 0;
        foreach (var line in sql.Split('\n'))
        {
            n++;
            if (Regex.IsMatch(line, @"^\s*GO\s*;?\s*$", RegexOptions.IgnoreCase))
            {
                if (sb.ToString().Trim().Length > 0) list.Add((sb.ToString(), start));
                sb.Clear();
                start = n + 1;
                continue;
            }
            sb.Append(line).Append('\n');
        }
        if (sb.ToString().Trim().Length > 0) list.Add((sb.ToString(), start));
        return list;
    }

    public async Task<DbQueryResultDto> QueryAsync(DbQueryRequest req, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var id = req.QueryId ?? Guid.NewGuid().ToString("N");
        running[id] = cts;
        var sw = Stopwatch.StartNew();
        var results = new List<DbResultDto>();
        var messages = new List<string>();
        var max = Math.Clamp(req.MaxRows, 1, 10_000);
        var batchLine = 1;
        try
        {
            await using var conn = await OpenAsync(req.Connection, cts.Token);
            if (conn is Microsoft.Data.SqlClient.SqlConnection sql) sql.InfoMessage += (_, e) => messages.Add(e.Message);
            if (conn is Npgsql.NpgsqlConnection pg) pg.Notice += (_, e) => messages.Add(e.Notice.MessageText);
            foreach (var (batch, line) in Batches(req.Connection.Kind, req.Sql))
            {
                batchLine = line;
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = batch;
                cmd.CommandTimeout = 0;
                await using var r = await cmd.ExecuteReaderAsync(cts.Token);
                do
                {
                    if (r.FieldCount == 0) continue;
                    var cols = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToList();
                    var types = Enumerable.Range(0, r.FieldCount).Select(i => SafeTypeName(r, i)).ToList();
                    var rows = new List<IReadOnlyList<string?>>();
                    var truncated = false;
                    while (await r.ReadAsync(cts.Token))
                    {
                        if (rows.Count >= max)
                        {
                            truncated = true;
                            break;
                        }
                        var row = new string?[r.FieldCount];
                        for (var i = 0; i < r.FieldCount; i++) row[i] = Format(r, i);
                        rows.Add(row);
                    }
                    results.Add(new DbResultDto(cols, types, rows, truncated, -1));
                } while (await r.NextResultAsync(cts.Token));
                if (r.RecordsAffected >= 0) messages.Add($"{r.RecordsAffected} row{(r.RecordsAffected == 1 ? "" : "s")} affected");
            }
            return new DbQueryResultDto(results, sw.ElapsedMilliseconds, messages, null, null);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new DbQueryResultDto(results, sw.ElapsedMilliseconds, messages, "Cancelled", null);
        }
        catch (Exception ex) when (ex is DbException or InvalidOperationException or ArgumentException or FileNotFoundException or TimeoutException)
        {
            int? errLine = ex is Microsoft.Data.SqlClient.SqlException se ? batchLine + se.LineNumber - 1 : null;
            if (ex is Npgsql.PostgresException pe && pe.Position > 0) errLine = req.Sql[..Math.Min(pe.Position - 1, req.Sql.Length)].Count(ch => ch == '\n') + 1;
            return new DbQueryResultDto(results, sw.ElapsedMilliseconds, messages, ex.Message, errLine);
        }
        finally
        {
            running.TryRemove(id, out _);
        }
    }

    public void Cancel(string id)
    {
        if (running.TryGetValue(id, out var cts)) cts.Cancel();
    }

    private static string SafeTypeName(DbDataReader r, int i)
    {
        try
        {
            return r.GetDataTypeName(i);
        }
        catch
        {
            return "";
        }
    }

    private static string? Format(DbDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        object v;
        try
        {
            v = r.GetValue(i);
        }
        catch (Exception ex)
        {
            return $"<{ex.GetType().Name}>";
        }
        return v switch
        {
            byte[] b => "0x" + Convert.ToHexString(b.AsSpan(0, Math.Min(b.Length, 64))) + (b.Length > 64 ? $"… ({b.Length} bytes)" : ""),
            DateTime d => d.TimeOfDay == TimeSpan.Zero && d.Kind == DateTimeKind.Unspecified ? d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : d.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
            DateTimeOffset d => d.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF zzz", CultureInfo.InvariantCulture),
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => v.ToString() is { Length: > 10_000 } s ? s[..10_000] + "…" : v.ToString(),
        };
    }

    // ------------------------------------------------------------------ appsettings.json

    /// <summary>Connection strings in the workspace's appsettings*.json (ConnectionStrings section), to import as data sources.</summary>
    public IReadOnlyList<DiscoveredSourceDto> Discover()
    {
        var root = workspace.Root;
        if (root is null) return [];
        var list = new List<DiscoveredSourceDto>();
        foreach (var file in Directory.EnumerateFiles(root, "appsettings*.json", SearchOption.AllDirectories))
        {
            if (file.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(PathUtil.IgnoredDirs.Contains)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                if (!doc.RootElement.TryGetProperty("ConnectionStrings", out var cs) || cs.ValueKind != JsonValueKind.Object) continue;
                foreach (var p in cs.EnumerateObject())
                {
                    if (p.Value.GetString() is not { Length: > 0 } value) continue;
                    var kind = Guess(value);
                    // a relative SQLite file is relative to the project folder
                    if (kind == "sqlite")
                    {
                        var b = new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder(value);
                        if (!Path.IsPathRooted(b.DataSource) && b.DataSource is not ":memory:")
                        {
                            b.DataSource = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(file)!, b.DataSource));
                            value = b.ConnectionString;
                        }
                    }
                    list.Add(new DiscoveredSourceDto(p.Name, kind, value, file));
                }
            }
            catch (Exception ex) when (ex is JsonException or IOException or ArgumentException)
            {
            }
        }
        return list;
    }

    private static string Guess(string cs)
    {
        var s = cs.ToLowerInvariant();
        if (Regex.IsMatch(s, @"data source\s*=\s*[^;]*\.(db|sqlite|sqlite3)\b|filename\s*=") || s.Contains(":memory:")) return "sqlite";
        if (s.Contains("host=") || s.Contains("username=")) return "postgres";
        if (s.Contains("uid=") || s.Contains("sslmode=") || Regex.IsMatch(s, @"\bport\s*=\s*3306")) return "mysql";
        return "sqlserver";
    }
}

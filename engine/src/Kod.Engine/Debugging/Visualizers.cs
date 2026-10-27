using System.Text;
using System.Text.RegularExpressions;

namespace Kod.Engine.Debugging;

/// <param name="VariablesReference">The variable's reference in the Variables tree (0 when only the expression is known).</param>
public sealed record VisualizeRequest(string Expression, int? FrameId, int VariablesReference = 0, int MaxRows = 500);

/// <summary>A table (collection, DataTable), a text (string), or why neither works.</summary>
public sealed record VisualDto(string Kind, string? Type, IReadOnlyList<string>? Columns, IReadOnlyList<IReadOnlyList<string>>? Rows, int? Total, string? Text, string? Message);

/// <summary>
/// Debugger visualizers, built from what the debugger already exposes (no code is injected into the program): an
/// IEnumerable or array as a grid (one row per element, one column per field or property), a DataTable as its rows,
/// and the full text of a string for the Text / JSON / XML / HTML viewers.
/// </summary>
internal static partial class Visualizers
{
    private const int MaxColumns = 40;

    public static async Task<VisualDto> VisualizeAsync(DebugService.Session s, VisualizeRequest r, CancellationToken ct)
    {
        var max = Math.Clamp(r.MaxRows, 1, 2000);
        var e = await s.EvaluateAsync(r.Expression, r.FrameId, "watch", ct);
        var type = e.Type ?? "";
        var reference = e.VariablesReference != 0 ? e.VariablesReference : r.VariablesReference;

        if (type is "string" or "System.String" || (reference == 0 && e.Result.StartsWith('"')))
            return new VisualDto("text", type, null, null, null, Unquote(e.Result), null);
        if (e.Result == "null") return new VisualDto("none", type, null, null, null, null, "The value is null.");
        if (type.Contains("DataTable", StringComparison.Ordinal)) return await DataTableAsync(s, r.Expression, r.FrameId, type, max, ct);
        if (reference == 0) return new VisualDto("text", type, null, null, null, e.Result, null);

        var children = await s.VariablesAsync(reference, ct);
        var elements = await ElementsAsync(s, r, children, max, ct);
        if (elements is null)
            return new VisualDto("none", type, null, null, null, null, "This value is not a collection the debugger can list. Try a .ToList() or .ToArray() of it in Evaluate.");
        return await TableAsync(s, elements.Value.Items, elements.Value.Total, type, ct);
    }

    /// <summary>The elements: an array's [i] children, a List's backing array, a Dictionary's entries, or ToArray().</summary>
    private static async Task<(List<(string Name, VariableDto Value)> Items, int? Total)?> ElementsAsync(DebugService.Session s, VisualizeRequest r, IReadOnlyList<VariableDto> children, int max, CancellationToken ct)
    {
        var indexed = children.Where(c => Indexer().IsMatch(c.Name)).ToList();
        if (indexed.Count > 0) return (indexed.Take(max).Select(c => (c.Name, c)).ToList(), CountOf(children) ?? indexed.Count);

        // List<T>, Stack<T>, Queue<T>: the backing array, cut to the count
        var size = IntOf(children.FirstOrDefault(c => c.Name is "_size" or "Count"));
        var array = children.FirstOrDefault(c => c.Name is "_items" or "_array" && c.VariablesReference != 0);
        if (array is not null)
        {
            var items = (await s.VariablesAsync(array.VariablesReference, ct, Math.Min(max, size ?? max))).Where(c => Indexer().IsMatch(c.Name)).ToList();
            if (size is { } n) items = items.Take(n).ToList();
            return (items.Take(max).Select(c => (c.Name, c)).ToList(), size ?? items.Count);
        }

        // Dictionary<K,V>: _entries, each with key and value
        var entries = children.FirstOrDefault(c => c.Name == "_entries" && c.VariablesReference != 0);
        if (entries is not null)
        {
            var count = IntOf(children.FirstOrDefault(c => c.Name is "_count" or "Count"));
            var rows = (await s.VariablesAsync(entries.VariablesReference, ct, Math.Min(max, count ?? max))).Where(c => Indexer().IsMatch(c.Name)).ToList();
            if (count is { } n) rows = rows.Take(n).ToList();
            return (rows.Take(max).Select(c => (c.Name, c)).ToList(), count ?? rows.Count);
        }

        // anything else with a ToArray() (HashSet, ImmutableArray, LINQ results via the user's own .ToArray())
        try
        {
            var arr = await s.EvaluateAsync($"({r.Expression}).ToArray()", r.FrameId, "watch", ct);
            if (arr.VariablesReference != 0)
            {
                var items = (await s.VariablesAsync(arr.VariablesReference, ct, max)).Where(c => Indexer().IsMatch(c.Name)).ToList();
                return (items.Select(c => (c.Name, c)).ToList(), items.Count);
            }
        }
        catch (InvalidOperationException)
        {
            // no ToArray, or the debugger cannot call it
        }
        return null;
    }

    /// <summary>One row per element: a simple value is one column; an object's fields and properties are columns.</summary>
    private static async Task<VisualDto> TableAsync(DebugService.Session s, List<(string Name, VariableDto Value)> items, int? total, string type, CancellationToken ct)
    {
        var columns = new List<string>();
        var rows = new List<Dictionary<string, string>>();
        var simple = items.All(i => i.Value.VariablesReference == 0 || i.Value.Value.StartsWith('"'));
        foreach (var (name, v) in items)
        {
            var row = new Dictionary<string, string>(StringComparer.Ordinal) { ["#"] = name.Trim('[', ']') };
            if (simple || v.VariablesReference == 0)
            {
                row["Value"] = await ShowAsync(s, v, ct);
                if (!columns.Contains("Value")) columns.Add("Value");
            }
            else
            {
                foreach (var f in await s.VariablesAsync(v.VariablesReference, ct, 200))
                {
                    // grouping nodes, backing fields, a record's EqualityContract and a Dictionary entry's bookkeeping
                    if (f.Name is "Static members" or "Non-Public members" or "Raw View" or "EqualityContract" || f.Name.StartsWith('<')) continue;
                    if (v.Type?.Contains("Entry", StringComparison.Ordinal) == true && f.Name is "hashCode" or "next") continue;
                    if (!columns.Contains(f.Name))
                    {
                        if (columns.Count >= MaxColumns) continue;
                        columns.Add(f.Name);
                    }
                    row[f.Name] = await ShowAsync(s, f, ct);
                }
            }
            rows.Add(row);
        }
        var all = new List<string> { "#" };
        all.AddRange(columns);
        return new VisualDto("table", type, all, rows.Select(r => (IReadOnlyList<string>)all.Select(c => r.GetValueOrDefault(c, "")).ToList()).ToList(), total, null, null);
    }

    private static async Task<VisualDto> DataTableAsync(DebugService.Session s, string expr, int? frame, string type, int max, CancellationToken ct)
    {
        async Task<string> Eval(string x) => (await s.EvaluateAsync(x, frame, "watch", ct)).Result;
        var cols = int.TryParse(await Eval($"{expr}.Columns.Count"), out var c) ? c : 0;
        var count = int.TryParse(await Eval($"{expr}.Rows.Count"), out var n) ? n : 0;
        var names = new List<string>();
        for (var i = 0; i < Math.Min(cols, MaxColumns); i++) names.Add(Unquote(await Eval($"{expr}.Columns[{i}].ColumnName")));
        var rows = new List<IReadOnlyList<string>>();
        for (var i = 0; i < Math.Min(count, max); i++)
        {
            var items = await s.EvaluateAsync($"{expr}.Rows[{i}].ItemArray", frame, "watch", ct);
            var values = new List<string>();
            if (items.VariablesReference != 0)
                foreach (var v in (await s.VariablesAsync(items.VariablesReference, ct, MaxColumns)).Where(v => Indexer().IsMatch(v.Name))) values.Add(await ShowAsync(s, v, ct));
            var row = new List<string> { i.ToString() };
            row.AddRange(names.Select((_, k) => k < values.Count ? values[k] : ""));
            rows.Add(row);
        }
        return new VisualDto("table", type, ["#", .. names], rows, count, null, null);
    }

    /// <summary>A boxed value (object[] cells show as {int}) as its text, through ToString() on it.</summary>
    private static async Task<string> ShowAsync(DebugService.Session s, VariableDto v, CancellationToken ct)
    {
        if (v.EvaluateName is null || !Boxed().IsMatch(v.Value)) return v.Value;
        try
        {
            var r = await s.EvaluateAsync($"({v.EvaluateName}).ToString()", null, "watch", ct);
            return r.Result.StartsWith('"') && v.Value is not "{string}" ? Unquote(r.Result) : r.Result;
        }
        catch (InvalidOperationException)
        {
            return v.Value;
        }
    }

    private static int? CountOf(IReadOnlyList<VariableDto> children) => IntOf(children.FirstOrDefault(c => c.Name is "Count" or "Length" or "_size"));

    private static int? IntOf(VariableDto? v) => v is not null && int.TryParse(v.Value, out var n) ? n : null;

    /// <summary>A C# string literal as the debugger shows it ("a\nb") back to its text.</summary>
    internal static string Unquote(string s)
    {
        if (s.Length < 2 || s[0] != '"' || s[^1] != '"') return s;
        var sb = new StringBuilder(s.Length);
        for (var i = 1; i < s.Length - 1; i++)
        {
            var ch = s[i];
            if (ch != '\\' || i + 1 >= s.Length - 1)
            {
                sb.Append(ch);
                continue;
            }
            var next = s[++i];
            switch (next)
            {
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case '0': sb.Append('\0'); break;
                case '"': sb.Append('"'); break;
                case '\'': sb.Append('\''); break;
                case '\\': sb.Append('\\'); break;
                case 'u' when i + 4 < s.Length - 1 && int.TryParse(s.AsSpan(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out var code):
                    sb.Append((char)code);
                    i += 4;
                    break;
                default:
                    sb.Append('\\').Append(next);
                    break;
            }
        }
        return sb.ToString();
    }

    [GeneratedRegex(@"^\{(int|long|short|byte|uint|ulong|ushort|sbyte|double|float|decimal|bool|char|System\.[\w.]+)\}$")]
    private static partial Regex Boxed();

    [GeneratedRegex(@"^\[\d+(,\s*\d+)*\]$")]
    private static partial Regex Indexer();
}

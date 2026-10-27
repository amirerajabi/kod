using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

public sealed partial class MemberRefactoringService
{
    // ------------------------------------------------------------------ Inline

    /// <summary>A constant or a readonly field with an initializer: its uses become the initializer.</summary>
    private static bool CanInlineField(ISymbol? s) =>
        s is IFieldSymbol { IsConst: true } or IFieldSymbol { IsReadOnly: true } && s.DeclaringSyntaxReferences is [var r]
        && r.GetSyntax() is VariableDeclaratorSyntax { Initializer: not null };

    private static bool CanInlineCalls(ISymbol? s) =>
        s is IMethodSymbol { MethodKind: MethodKind.Ordinary, IsAbstract: false, IsVirtual: false, IsOverride: false, IsPartialDefinition: false } m
        && m.DeclaringSyntaxReferences is [var r] && r.GetSyntax() is MethodDeclarationSyntax { Body: not null } or MethodDeclarationSyntax { ExpressionBody: not null };

    /// <summary>Roslyn's inline refactorings at the caret (Inline temporary variable, Inline method at this call) and Kod's own.</summary>
    public async Task<InlineInfoDto> InlineInfoAsync(RangeRequest r, CancellationToken ct)
    {
        var roslyn = (await actions.GetAsync(r with { Invoked = true }, ct))
            .Where(a => a.Kind == "refactor" && a.Title.StartsWith("Inline", StringComparison.OrdinalIgnoreCase)).ToList();
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Range.StartLine, r.Range.StartColumn, ct);
        var usages = 0;
        if (symbol is not null && (CanInlineField(symbol) || CanInlineCalls(symbol)))
            foreach (var rs in await SymbolFinder.FindReferencesAsync(symbol.OriginalDefinition, doc.Project.Solution, ct))
                usages += rs.Locations.Count(l => l.Location.IsInSource);
        return new InlineInfoDto(symbol?.Name, symbol is null ? null : symbol is ILocalSymbol ? "local" : Kinds.FromSymbol(symbol), roslyn, CanInlineField(symbol), usages, CanInlineCalls(symbol));
    }

    public async Task<IReadOnlyList<FileEditsDto>> InlineFieldAsync(InlineRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (!CanInlineField(symbol)) throw new InvalidOperationException("Put the caret on a constant or a readonly field with an initializer");
        var field = (IFieldSymbol)symbol!.OriginalDefinition;
        var declarator = (VariableDeclaratorSyntax)await field.DeclaringSyntaxReferences[0].GetSyntaxAsync(ct);
        var solution = doc.Project.Solution;
        var declDoc = solution.GetDocument(declarator.SyntaxTree)!;
        var model = (await declDoc.GetSemanticModelAsync(ct))!;

        // the initializer, with the type's own static members qualified so it binds anywhere
        var value = declarator.Initializer!.Value;
        var names = value.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
            .Where(n => n.Parent is not MemberAccessExpressionSyntax ma || ma.Expression == n)
            .Where(n => model.GetSymbolInfo(n, ct).Symbol is { IsStatic: true, ContainingType: { } ct2 } s && s is not INamedTypeSymbol && SymbolEqualityComparer.Default.Equals(ct2, field.ContainingType))
            .ToList();
        var owner = field.ContainingType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        value = value.ReplaceNodes(names, (n, _) => SyntaxFactory.ParseExpression($"{owner}.{n.Identifier.Text}").WithTriviaFrom(n));
        var replacement = SyntaxFactory.ParenthesizedExpression(value.WithoutTrivia());

        var editor = new SolutionEditor(solution);
        foreach (var rs in await SymbolFinder.FindReferencesAsync(field, solution, ct))
        foreach (var l in rs.Locations.Where(l => l.Location.IsInSource))
        {
            var de = await editor.GetDocumentEditorAsync(l.Document.Id, ct);
            var node = (await l.Location.SourceTree!.GetRootAsync(ct)).FindNode(l.Location.SourceSpan, getInnermostNodeForTie: true);
            if (IsWrite(node)) throw new InvalidOperationException($"'{field.Name}' is assigned in {Path.GetFileName(l.Document.FilePath)}: it cannot be inlined");
            var target = node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node ? ma : node;
            de.ReplaceNode(target, replacement.WithTriviaFrom(target).WithAdditionalAnnotations(Simplifier.Annotation));
        }
        var declEditor = await editor.GetDocumentEditorAsync(declDoc.Id, ct);
        declEditor.RemoveNode(declarator.Parent is VariableDeclarationSyntax { Variables.Count: 1, Parent: { } fd } ? fd : declarator, SyntaxRemoveOptions.KeepUnbalancedDirectives);
        var after = await CleanUpAsync(solution, editor.GetChangedSolution(), ct);
        return await IntelService.DiffAsync(solution, after, ct);
    }

    private static readonly Lazy<CodeRefactoringProvider?> InlineMethodProvider = new(() =>
    {
        Type[] types;
        try
        {
            types = Assembly.Load("Microsoft.CodeAnalysis.CSharp.Features").GetTypes();
        }
        catch (ReflectionTypeLoadException e)
        {
            types = e.Types.OfType<Type>().ToArray();
        }
        var t = types.FirstOrDefault(x => x.Name == "CSharpInlineMethodRefactoringProvider");
        return t?.GetConstructor(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, Type.EmptyTypes)?.Invoke(null) as CodeRefactoringProvider;
    });

    /// <summary>Inlines every call of a method with Roslyn's Inline Method, one call at a time, then removes it unless <see cref="InlineRequest.Keep"/>.</summary>
    public async Task<IReadOnlyList<FileEditsDto>> InlineCallsAsync(InlineRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (!CanInlineCalls(symbol)) throw new InvalidOperationException("Put the caret on a method with a body");
        var provider = InlineMethodProvider.Value ?? throw new InvalidOperationException("Roslyn's Inline Method is not available");
        var method = (IMethodSymbol)symbol!.OriginalDefinition;
        var declId = DocumentationCommentId.CreateDeclarationId(method)!;
        var projectId = doc.Project.Solution.GetDocument(method.DeclaringSyntaxReferences[0].SyntaxTree)!.Project.Id;
        var before = doc.Project.Solution;
        var solution = before;

        async Task<IMethodSymbol?> Resolve()
        {
            var c = await solution.GetProject(projectId)!.GetCompilationAsync(ct);
            return DocumentationCommentId.GetFirstSymbolForDeclarationId(declId, c!) as IMethodSymbol;
        }

        // the call at the caret, for Inline this call only
        TextSpan? only = null;
        if (r.ThisCall)
        {
            var root = (await doc.GetSyntaxRootAsync(ct))!;
            var pos = IntelService.Offset(await doc.GetTextAsync(ct), r.Line, r.Column);
            only = root.FindToken(pos).Parent?.FirstAncestorOrSelf<InvocationExpressionSyntax>()?.Span ?? throw new InvalidOperationException("Put the caret on a call to inline it");
        }

        var inlined = 0;
        var m0 = await Resolve();
        if (m0 is not null && SingleExpression((MethodDeclarationSyntax)await m0.DeclaringSyntaxReferences[0].GetSyntaxAsync(ct)) is not null)
        {
            // Kod's own: Roslyn only inlines methods that are not public
            for (var pass = 0; pass < 20; pass++)
            {
                var (next, n) = await InlineExpressionPassAsync(solution, await Resolve() ?? throw new InvalidOperationException("The method could not be found again"), only is null ? null : (doc.Id, only.Value), r.Keep || r.ThisCall, ct);
                solution = next;
                inlined += n;
                if (n == 0 || only is not null) break;
            }
            solution = await CleanUpAsync(before, solution, ct);
        }
        else for (var guard = 0; guard < 500; guard++)
        {
            var m = await Resolve() ?? throw new InvalidOperationException("The method could not be found again");
            var self = m.DeclaringSyntaxReferences[0];
            Location? call = null;
            foreach (var rs in await SymbolFinder.FindReferencesAsync(m, solution, ct))
            {
                call = rs.Locations.Select(l => l.Location).FirstOrDefault(l => l.IsInSource && !(l.SourceTree == self.SyntaxTree && self.Span.Contains(l.SourceSpan))
                    && (only is null || solution.GetDocumentId(l.SourceTree) == doc.Id && only.Value.Contains(l.SourceSpan))
                    && l.SourceTree!.GetRoot(ct).FindNode(l.SourceSpan, getInnermostNodeForTie: true).FirstAncestorOrSelf<InvocationExpressionSyntax>() is not null);
                if (call is not null) break;
            }
            if (call is null) break;
            var target = solution.GetDocument(call.SourceTree)!;
            var found = new List<CodeAction>();
            var invocation = (await call.SourceTree!.GetRootAsync(ct)).FindNode(call.SourceSpan, getInnermostNodeForTie: true).FirstAncestorOrSelf<InvocationExpressionSyntax>()!;
            foreach (var span in new[] { call.SourceSpan, new TextSpan(call.SourceSpan.Start, 0), invocation.Span })
            {
                try
                {
                    await provider.ComputeRefactoringsAsync(new CodeRefactoringContext(target, span, a => found.Add(a), ct));
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    log.LogDebug(ex, "Inline Method failed at {Span}", span);
                }
                if (found.Count > 0) break;
            }
            var all = Flatten(found).ToList();
            var keep = all.FirstOrDefault(a => a.Title.Contains("keep", StringComparison.OrdinalIgnoreCase)) ?? all.FirstOrDefault();
            if (keep is null)
            {
                var line = call.GetLineSpan().StartLinePosition.Line + 1;
                throw new InvalidOperationException($"The call in {Path.GetFileName(target.FilePath)} line {line} cannot be inlined (Kod inlines methods whose body is one expression; Roslyn inlines longer ones only when they are not public)");
            }
            var ops = await keep.GetOperationsAsync(ct);
            solution = ops.OfType<ApplyChangesOperation>().FirstOrDefault()?.ChangedSolution ?? throw new InvalidOperationException("Inline Method made no change");
            inlined++;
            if (only is not null) break;
        }
        if (inlined == 0 && (r.Keep || r.ThisCall)) throw new InvalidOperationException($"'{method.Name}' is not called anywhere");
        log.LogDebug("Inlined {Count} calls of {Method}", inlined, method.Name);

        if (!r.Keep && !r.ThisCall && await Resolve() is { } left)
        {
            var node = await left.DeclaringSyntaxReferences[0].GetSyntaxAsync(ct);
            var d = solution.GetDocument(node.SyntaxTree)!;
            var editor = await DocumentEditor.CreateAsync(d, ct);
            editor.RemoveNode(node, SyntaxRemoveOptions.KeepUnbalancedDirectives);
            solution = editor.GetChangedDocument().Project.Solution;
        }
        return await IntelService.DiffAsync(before, solution, ct);
    }

    /// <summary>The one expression a method computes: its expression body, a lone return or a lone expression statement.</summary>
    private static ExpressionSyntax? SingleExpression(MethodDeclarationSyntax d) =>
        d.ExpressionBody?.Expression ?? d.Body?.Statements switch
        {
            [ReturnStatementSyntax { Expression: { } e }] => e,
            [ExpressionStatementSyntax s] => s.Expression,
            _ => null,
        };

    private static bool Inherits(INamedTypeSymbol type, INamedTypeSymbol baseType)
    {
        for (var t = type; t is not null; t = t.BaseType)
            if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, baseType.OriginalDefinition)) return true;
        return false;
    }

    private static bool IsSimple(ExpressionSyntax e) =>
        e is LiteralExpressionSyntax or IdentifierNameSyntax or ThisExpressionSyntax or MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax or IdentifierNameSyntax };

    /// <summary>Replaces each call (not nested in another one being replaced) with the method's expression: parameters become the
    /// arguments, the method's own members go through the call's receiver. Returns how many calls it inlined.</summary>
    private static async Task<(Solution, int)> InlineExpressionPassAsync(Solution solution, IMethodSymbol method, (DocumentId Doc, TextSpan Span)? only, bool keep, CancellationToken ct)
    {
        if (method.IsGenericMethod || method.Parameters.Any(p => p.RefKind != RefKind.None || p.IsParams))
            throw new InvalidOperationException($"Kod cannot inline '{method.Name}': generic methods and ref, out or params parameters are not supported");
        var decl = (MethodDeclarationSyntax)await method.DeclaringSyntaxReferences[0].GetSyntaxAsync(ct);
        var body = SingleExpression(decl)!;
        var model = (await solution.GetDocument(decl.SyntaxTree)!.GetSemanticModelAsync(ct))!;
        var owner = method.ContainingType;
        bool Mine(ISymbol s) => s is not INamedTypeSymbol and not IParameterSymbol and not ILocalSymbol && s.ContainingType is { } t && Inherits(owner, t);
        var names = body.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
            .Where(n => n.Parent is not MemberAccessExpressionSyntax ma || ma.Expression == n)
            .Select(n => (Node: n, Symbol: model.GetSymbolInfo(n, ct).Symbol))
            .Where(x => x.Symbol is not null)
            .ToList();
        var uses = names.Where(x => x.Symbol is IParameterSymbol p && SymbolEqualityComparer.Default.Equals(p.ContainingSymbol, method))
            .GroupBy(x => ((IParameterSymbol)x.Symbol!).Ordinal).ToDictionary(g => g.Key, g => g.Count());
        var instanceUses = names.Count(x => Mine(x.Symbol!) && !x.Symbol!.IsStatic) + body.DescendantNodesAndSelf().OfType<ThisExpressionSyntax>().Count();

        var editor = new SolutionEditor(solution);
        var done = new List<(SyntaxTree Tree, TextSpan Span)>();
        var count = 0;
        foreach (var rs in await SymbolFinder.FindReferencesAsync(method, solution, ct))
        foreach (var loc in rs.Locations.Select(l => l.Location).Where(l => l.IsInSource).OrderBy(l => l.SourceSpan.Start))
        {
            if (loc.SourceTree == decl.SyntaxTree && decl.Span.Contains(loc.SourceSpan)) continue;
            var node = (await loc.SourceTree!.GetRootAsync(ct)).FindNode(loc.SourceSpan, getInnermostNodeForTie: true);
            var callee = node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node ? (ExpressionSyntax)ma : (ExpressionSyntax)node;
            if (callee.Parent is not InvocationExpressionSyntax inv || inv.Expression != callee)
            {
                if (!keep) throw new InvalidOperationException($"'{method.Name}' is used as a method group in {Path.GetFileName(loc.SourceTree.FilePath)}: keep the method");
                continue;
            }
            var docId = solution.GetDocumentId(loc.SourceTree)!;
            if (only is { } o && (docId != o.Doc || !o.Span.Contains(inv.Span))) continue;
            if (done.Any(d => d.Tree == loc.SourceTree && (d.Span.Contains(inv.Span) || inv.Span.Contains(d.Span)))) continue;
            var receiver = (callee as MemberAccessExpressionSyntax)?.Expression;
            if (receiver is BaseExpressionSyntax) continue;
            if (receiver is not null && instanceUses > 1 && !IsSimple(receiver))
                throw new InvalidOperationException($"'{receiver}' would be evaluated more than once: introduce a variable for it first");

            // the argument of each parameter, by name or position, else its default value
            var args = new ExpressionSyntax?[method.Parameters.Length];
            for (var i = 0; i < inv.ArgumentList.Arguments.Count; i++)
            {
                var a = inv.ArgumentList.Arguments[i];
                var index = a.NameColon is { } nc ? method.Parameters.IndexOf(method.Parameters.First(p => p.Name == nc.Name.Identifier.ValueText)) : i;
                args[index] = a.Expression;
            }
            for (var i = 0; i < args.Length; i++)
            {
                args[i] ??= decl.ParameterList.Parameters[i].Default?.Value ?? throw new InvalidOperationException("A call is missing an argument");
                if (uses.GetValueOrDefault(i) > 1 && !IsSimple(args[i]!))
                    throw new InvalidOperationException($"'{args[i]}' would be evaluated more than once: introduce a variable for it first");
            }

            var map = new Dictionary<SyntaxNode, SyntaxNode>();
            foreach (var (n, s) in names)
            {
                if (s is IParameterSymbol p && SymbolEqualityComparer.Default.Equals(p.ContainingSymbol, method))
                    map[n] = SyntaxFactory.ParenthesizedExpression(args[p.Ordinal]!.WithoutTrivia()).WithTriviaFrom(n).WithAdditionalAnnotations(Simplifier.Annotation);
                else if (Mine(s!) && s!.IsStatic)
                    map[n] = SyntaxFactory.ParseExpression($"{s.ContainingType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}.{n.Identifier.Text}").WithTriviaFrom(n).WithAdditionalAnnotations(Simplifier.Annotation);
                else if (Mine(s!) && receiver is not null)
                    map[n] = SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, SyntaxFactory.ParenthesizedExpression(receiver.WithoutTrivia()).WithAdditionalAnnotations(Simplifier.Annotation), n.WithoutTrivia()).WithTriviaFrom(n);
            }
            if (receiver is not null)
                foreach (var t in body.DescendantNodesAndSelf().OfType<ThisExpressionSyntax>())
                    map[t] = SyntaxFactory.ParenthesizedExpression(receiver.WithoutTrivia()).WithTriviaFrom(t).WithAdditionalAnnotations(Simplifier.Annotation);
            var inlined = body.ReplaceNodes(map.Keys, (orig, _) => map[orig]).WithoutTrivia();

            var de = await editor.GetDocumentEditorAsync(docId, ct);
            if (names.FirstOrDefault(x => Mine(x.Symbol!) && !de.SemanticModel.IsAccessible(inv.SpanStart, x.Symbol!)) is { Symbol: { } hidden })
                throw new InvalidOperationException($"'{method.Name}' uses '{hidden.Name}', which is not accessible in {Path.GetFileName(loc.SourceTree.FilePath)}");
            if (inv.Parent is ExpressionStatementSyntax) de.ReplaceNode(inv, inlined.WithTriviaFrom(inv));
            else if (method.ReturnsVoid) throw new InvalidOperationException("A call of a void method is not a statement");
            else de.ReplaceNode(inv, SyntaxFactory.ParenthesizedExpression(inlined).WithTriviaFrom(inv).WithAdditionalAnnotations(Simplifier.Annotation));
            done.Add((loc.SourceTree, inv.Span));
            count++;
        }
        return (editor.GetChangedSolution(), count);
    }

    private static readonly PropertyInfo? NestedProperty =
        typeof(CodeAction).GetProperty("NestedActions", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
        ?? typeof(CodeAction).GetProperty("NestedCodeActions", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

    private static IEnumerable<CodeAction> Flatten(IEnumerable<CodeAction> list)
    {
        foreach (var a in list)
        {
            var nested = NestedProperty?.GetValue(a) is ImmutableArray<CodeAction> arr ? arr : default;
            if (nested.IsDefaultOrEmpty) yield return a;
            else foreach (var n in Flatten(nested)) yield return n;
        }
    }
}

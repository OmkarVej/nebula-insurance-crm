// Symbol-layer extractor for C#. Invoked by scripts/kg/symbols.py.
// Reads a JSON array of repo-relative file paths from stdin, parses each
// with Roslyn (Microsoft.CodeAnalysis.CSharp), and writes a JSON array of
// symbol records to stdout. One record per type declaration plus per
// method, property, and constructor.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CSharpSymbols;

public sealed record SymbolItem(
    [property: JsonPropertyName("file")] string File,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("container")] string? Container,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("line")] int Line,
    [property: JsonPropertyName("signature")] string Signature,
    [property: JsonPropertyName("visibility")] string Visibility,
    [property: JsonPropertyName("calls")] string[] Calls
);

public static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        try { return Run(); }
        catch (Exception ex)
        {
            Console.Error.WriteLine("extractor crashed: " + ex);
            return 1;
        }
    }

    private static int Run()
    {
        var stdin = Console.In.ReadToEnd();
        string[] files;
        try
        {
            files = JsonSerializer.Deserialize<string[]>(stdin) ?? Array.Empty<string>();
        }
        catch (JsonException ex)
        {
            Console.Error.WriteLine("invalid stdin JSON: " + ex.Message);
            return 1;
        }

        var items = new List<SymbolItem>(capacity: files.Length * 8);

        foreach (var rel in files)
        {
            string source;
            try { source = File.ReadAllText(rel); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"read failed {rel}: {ex.Message}");
                continue;
            }

            CompilationUnitSyntax root;
            try
            {
                var tree = CSharpSyntaxTree.ParseText(SourceText.From(source), path: rel);
                root = (CompilationUnitSyntax)tree.GetRoot();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"parse failed {rel}: {ex.Message}");
                continue;
            }

            foreach (var member in EnumerateTopLevelMembers(root))
            {
                EmitMember(rel, container: null, member, items);
            }
        }

        Console.Out.Write(JsonSerializer.Serialize(items, JsonOptions));
        return 0;
    }

    private static IEnumerable<MemberDeclarationSyntax> EnumerateTopLevelMembers(CompilationUnitSyntax root)
    {
        foreach (var m in root.Members)
        {
            if (m is BaseNamespaceDeclarationSyntax ns)
            {
                foreach (var inner in ns.Members) yield return inner;
            }
            else
            {
                yield return m;
            }
        }
    }

    private static void EmitMember(
        string rel, string? container, MemberDeclarationSyntax member, List<SymbolItem> items)
    {
        switch (member)
        {
            case TypeDeclarationSyntax type:
                EmitType(rel, container, type, items);
                break;
            case EnumDeclarationSyntax e:
                items.Add(new SymbolItem(
                    File: rel,
                    Name: e.Identifier.ValueText,
                    Container: container,
                    Kind: "enum",
                    Line: LineOf(e),
                    Signature: Signature(e),
                    Visibility: VisibilityOf(e.Modifiers),
                    Calls: Array.Empty<string>()));
                break;
            case DelegateDeclarationSyntax d:
                items.Add(new SymbolItem(
                    File: rel,
                    Name: d.Identifier.ValueText,
                    Container: container,
                    Kind: "delegate",
                    Line: LineOf(d),
                    Signature: Signature(d),
                    Visibility: VisibilityOf(d.Modifiers),
                    Calls: Array.Empty<string>()));
                break;
        }
    }

    private static void EmitType(
        string rel, string? container, TypeDeclarationSyntax type, List<SymbolItem> items)
    {
        var name = type.Identifier.ValueText;
        var kind = type switch
        {
            InterfaceDeclarationSyntax => "interface",
            RecordDeclarationSyntax => "record",
            StructDeclarationSyntax => "struct",
            _ => "class",
        };

        items.Add(new SymbolItem(
            File: rel,
            Name: name,
            Container: container,
            Kind: kind,
            Line: LineOf(type),
            Signature: Signature(type),
            Visibility: VisibilityOf(type.Modifiers),
            Calls: Array.Empty<string>()));

        foreach (var member in type.Members)
        {
            switch (member)
            {
                case TypeDeclarationSyntax nested:
                    EmitType(rel, name, nested, items);
                    break;
                case EnumDeclarationSyntax e:
                    items.Add(new SymbolItem(
                        File: rel,
                        Name: e.Identifier.ValueText,
                        Container: name,
                        Kind: "enum",
                        Line: LineOf(e),
                        Signature: Signature(e),
                        Visibility: VisibilityOf(e.Modifiers),
                        Calls: Array.Empty<string>()));
                    break;
                case MethodDeclarationSyntax m:
                    items.Add(new SymbolItem(
                        File: rel,
                        Name: m.Identifier.ValueText,
                        Container: name,
                        Kind: "method",
                        Line: LineOf(m),
                        Signature: Signature(m),
                        Visibility: VisibilityOf(m.Modifiers),
                        Calls: Calls(m)));
                    break;
                case PropertyDeclarationSyntax p:
                    items.Add(new SymbolItem(
                        File: rel,
                        Name: p.Identifier.ValueText,
                        Container: name,
                        Kind: "property",
                        Line: LineOf(p),
                        Signature: Signature(p),
                        Visibility: VisibilityOf(p.Modifiers),
                        Calls: Calls(p)));
                    break;
                case ConstructorDeclarationSyntax ctor:
                    // Emit constructor with synthetic name ".ctor" so its symbol
                    // id is distinct from the type's symbol id.
                    items.Add(new SymbolItem(
                        File: rel,
                        Name: ".ctor",
                        Container: name,
                        Kind: "constructor",
                        Line: LineOf(ctor),
                        Signature: Signature(ctor),
                        Visibility: VisibilityOf(ctor.Modifiers),
                        Calls: Calls(ctor)));
                    break;
            }
        }
    }

    private static int LineOf(SyntaxNode node) =>
        node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private static string VisibilityOf(SyntaxTokenList modifiers)
    {
        var hasPublic = false;
        var hasInternal = false;
        var hasProtected = false;
        var hasPrivate = false;
        foreach (var m in modifiers)
        {
            if (m.IsKind(SyntaxKind.PublicKeyword)) hasPublic = true;
            else if (m.IsKind(SyntaxKind.InternalKeyword)) hasInternal = true;
            else if (m.IsKind(SyntaxKind.ProtectedKeyword)) hasProtected = true;
            else if (m.IsKind(SyntaxKind.PrivateKeyword)) hasPrivate = true;
        }
        if (hasPublic) return "public";
        if (hasInternal) return "internal";
        if (hasProtected) return "protected";
        if (hasPrivate) return "private";
        return "internal";
    }

    private static string Signature(MemberDeclarationSyntax node)
    {
        int start = int.MaxValue;
        if (node.Modifiers.Count > 0)
        {
            start = Math.Min(start, node.Modifiers[0].SpanStart);
        }
        foreach (var child in node.ChildNodes())
        {
            if (child is AttributeListSyntax) continue;
            start = Math.Min(start, child.SpanStart);
        }
        if (start == int.MaxValue || start < node.SpanStart) start = node.SpanStart;
        var end = node.Span.End;
        var text = node.SyntaxTree.GetText().ToString(new Microsoft.CodeAnalysis.Text.TextSpan(start, end - start));
        var cut = text.Length;
        var braceIdx = text.IndexOf('{');
        if (braceIdx > 0) cut = Math.Min(cut, braceIdx);
        var arrowIdx = text.IndexOf("=>", StringComparison.Ordinal);
        if (arrowIdx > 0) cut = Math.Min(cut, arrowIdx);
        var semiIdx = text.IndexOf(';');
        if (semiIdx > 0) cut = Math.Min(cut, semiIdx);
        var nlIdx = text.IndexOf('\n');
        if (nlIdx > 0) cut = Math.Min(cut, nlIdx);
        return text.Substring(0, cut).Trim();
    }

    private static string[] Calls(SyntaxNode node)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var inv in node.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            switch (inv.Expression)
            {
                case IdentifierNameSyntax id:
                    result.Add(id.Identifier.ValueText);
                    break;
                case MemberAccessExpressionSyntax ma:
                    result.Add(ma.Name.Identifier.ValueText);
                    break;
                case GenericNameSyntax gn:
                    result.Add(gn.Identifier.ValueText);
                    break;
                case MemberBindingExpressionSyntax mb:
                    result.Add(mb.Name.Identifier.ValueText);
                    break;
            }
        }
        return result.ToArray();
    }
}

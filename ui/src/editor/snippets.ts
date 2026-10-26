// C# live templates (Rider / Visual Studio names). Bodies use Monaco snippet syntax.
export interface Snippet {
  prefix: string;
  description: string;
  body: string;
}

export const CSHARP_SNIPPETS: Snippet[] = [
  { prefix: 'cw', description: 'Console.WriteLine', body: 'Console.WriteLine($0);' },
  { prefix: 'prop', description: 'Auto property', body: 'public ${1:int} ${2:Name} { get; set; }$0' },
  { prefix: 'propg', description: 'Get-only property', body: 'public ${1:int} ${2:Name} { get; }$0' },
  { prefix: 'propfull', description: 'Property with backing field', body: 'private ${1:int} ${2:_name};\n\npublic ${1:int} ${3:Name}\n{\n\tget => ${2:_name};\n\tset => ${2:_name} = value;\n}$0' },
  { prefix: 'ctor', description: 'Constructor', body: 'public ${1:ClassName}($2)\n{\n\t$0\n}' },
  { prefix: 'class', description: 'Class', body: 'public class ${1:Name}\n{\n\t$0\n}' },
  { prefix: 'record', description: 'Record', body: 'public record ${1:Name}(${2:string Value});$0' },
  { prefix: 'interface', description: 'Interface', body: 'public interface I${1:Name}\n{\n\t$0\n}' },
  { prefix: 'enum', description: 'Enum', body: 'public enum ${1:Name}\n{\n\t$0\n}' },
  { prefix: 'struct', description: 'Struct', body: 'public struct ${1:Name}\n{\n\t$0\n}' },
  { prefix: 'if', description: 'if statement', body: 'if (${1:condition})\n{\n\t$0\n}' },
  { prefix: 'else', description: 'else block', body: 'else\n{\n\t$0\n}' },
  { prefix: 'for', description: 'for loop', body: 'for (var ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++)\n{\n\t$0\n}' },
  { prefix: 'forr', description: 'Reverse for loop', body: 'for (var ${1:i} = ${2:length} - 1; ${1:i} >= 0; ${1:i}--)\n{\n\t$0\n}' },
  { prefix: 'foreach', description: 'foreach loop', body: 'foreach (var ${1:item} in ${2:collection})\n{\n\t$0\n}' },
  { prefix: 'while', description: 'while loop', body: 'while (${1:condition})\n{\n\t$0\n}' },
  { prefix: 'do', description: 'do-while loop', body: 'do\n{\n\t$0\n} while (${1:condition});' },
  { prefix: 'switch', description: 'switch statement', body: 'switch (${1:value})\n{\n\tcase ${2:x}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}' },
  { prefix: 'try', description: 'try/catch', body: 'try\n{\n\t$1\n}\ncatch (${2:Exception} ${3:ex})\n{\n\t$0\n}' },
  { prefix: 'tryf', description: 'try/finally', body: 'try\n{\n\t$1\n}\nfinally\n{\n\t$0\n}' },
  { prefix: 'using', description: 'using statement', body: 'using (var ${1:resource} = ${2:expression})\n{\n\t$0\n}' },
  { prefix: 'lock', description: 'lock statement', body: 'lock (${1:_sync})\n{\n\t$0\n}' },
  { prefix: 'main', description: 'Main method', body: 'static void Main(string[] args)\n{\n\t$0\n}' },
  { prefix: 'svm', description: 'static void Main', body: 'static void Main(string[] args)\n{\n\t$0\n}' },
  { prefix: 'amain', description: 'async Main', body: 'static async Task Main(string[] args)\n{\n\t$0\n}' },
  { prefix: 'asyncm', description: 'async method', body: 'public async Task ${1:MethodAsync}()\n{\n\t$0\n}' },
  { prefix: 'region', description: '#region', body: '#region ${1:Name}\n\n$0\n\n#endregion' },
  { prefix: 'fact', description: 'xUnit test', body: '[Fact]\npublic void ${1:Should_do_something}()\n{\n\t// Arrange\n\t$0\n\t// Act\n\n\t// Assert\n}' },
  { prefix: 'theory', description: 'xUnit theory', body: '[Theory]\n[InlineData(${1:1})]\npublic void ${2:Test}(${3:int value})\n{\n\t$0\n}' },
  { prefix: 'test', description: 'NUnit / MSTest test', body: '[Test]\npublic void ${1:Test}()\n{\n\t$0\n}' },
  { prefix: 'exception', description: 'Custom exception', body: 'public class ${1:My}Exception : Exception\n{\n\tpublic ${1:My}Exception() { }\n\tpublic ${1:My}Exception(string message) : base(message) { }\n\tpublic ${1:My}Exception(string message, Exception inner) : base(message, inner) { }\n}' },
  { prefix: 'ifnull', description: 'Throw if null', body: 'ArgumentNullException.ThrowIfNull(${1:value});' },
  { prefix: 'nameof', description: 'nameof', body: 'nameof(${1:member})$0' },
];

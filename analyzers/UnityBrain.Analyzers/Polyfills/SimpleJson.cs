using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

[assembly: InternalsVisibleTo("UnityBrain.Analyzers.Tests")]

namespace UnityBrain.Analyzers.Json;

internal static class SimpleJson
{
    public static object? Parse(string json)
    {
        int idx = 0;
        SkipWhitespace(json, ref idx);
        if (idx >= json.Length) return null;
        return ParseValue(json, ref idx);
    }

    private static void SkipWhitespace(string s, ref int idx)
    {
        while (idx < s.Length && (char.IsWhiteSpace(s[idx]) || s[idx] == '\uFEFF')) idx++;
    }

    private static object? ParseValue(string s, ref int idx)
    {
        SkipWhitespace(s, ref idx);
        if (idx >= s.Length) return null;
        char c = s[idx];
        return c switch
        {
            '{' => ParseObject(s, ref idx),
            '[' => ParseArray(s, ref idx),
            '"' => ParseString(s, ref idx),
            't' or 'f' => ParseBool(s, ref idx),
            'n' => ParseNull(s, ref idx),
            _ => ParseNumber(s, ref idx),
        };
    }

    private static Dictionary<string, object?> ParseObject(string s, ref int idx)
    {
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        idx++; // '{'
        SkipWhitespace(s, ref idx);
        if (idx < s.Length && s[idx] == '}')
        {
            idx++;
            return dict;
        }
        while (idx < s.Length)
        {
            SkipWhitespace(s, ref idx);
            if (idx >= s.Length || s[idx] != '"') break;
            string key = ParseString(s, ref idx);
            SkipWhitespace(s, ref idx);
            if (idx < s.Length && s[idx] == ':') idx++;
            var val = ParseValue(s, ref idx);
            dict[key] = val;
            SkipWhitespace(s, ref idx);
            if (idx < s.Length && s[idx] == ',')
            {
                idx++;
                continue;
            }
            if (idx < s.Length && s[idx] == '}')
            {
                idx++;
                break;
            }
            break;
        }
        return dict;
    }

    private static List<object?> ParseArray(string s, ref int idx)
    {
        var list = new List<object?>();
        idx++; // '['
        SkipWhitespace(s, ref idx);
        if (idx < s.Length && s[idx] == ']')
        {
            idx++;
            return list;
        }
        while (idx < s.Length)
        {
            var val = ParseValue(s, ref idx);
            list.Add(val);
            SkipWhitespace(s, ref idx);
            if (idx < s.Length && s[idx] == ',')
            {
                idx++;
                continue;
            }
            if (idx < s.Length && s[idx] == ']')
            {
                idx++;
                break;
            }
            break;
        }
        return list;
    }

    private static string ParseString(string s, ref int idx)
    {
        var sb = new StringBuilder();
        idx++; // '"'
        while (idx < s.Length)
        {
            char c = s[idx++];
            if (c == '"') break;
            if (c == '\\' && idx < s.Length)
            {
                char esc = s[idx++];
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u' when idx + 4 <= s.Length:
                        if (ushort.TryParse(s.Substring(idx, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var code))
                        {
                            sb.Append((char)code);
                        }
                        idx += 4;
                        break;
                    default: sb.Append(esc); break;
                }
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    private static bool ParseBool(string s, ref int idx)
    {
        if (idx + 4 <= s.Length && string.Compare(s, idx, "true", 0, 4, StringComparison.Ordinal) == 0)
        {
            idx += 4;
            return true;
        }
        if (idx + 5 <= s.Length && string.Compare(s, idx, "false", 0, 5, StringComparison.Ordinal) == 0)
        {
            idx += 5;
            return false;
        }
        throw new FormatException("Invalid JSON boolean");
    }

    private static object? ParseNull(string s, ref int idx)
    {
        if (idx + 4 <= s.Length && string.Compare(s, idx, "null", 0, 4, StringComparison.Ordinal) == 0)
        {
            idx += 4;
            return null;
        }
        throw new FormatException("Invalid JSON null");
    }

    private static double ParseNumber(string s, ref int idx)
    {
        int start = idx;
        while (idx < s.Length && (char.IsDigit(s[idx]) || s[idx] is '-' or '+' or '.' or 'e' or 'E'))
        {
            idx++;
        }
        if (idx == start) throw new FormatException("Invalid JSON token");
        return double.TryParse(s.Substring(start, idx - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
    }
}

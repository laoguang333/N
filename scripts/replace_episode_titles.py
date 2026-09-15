"""将小说标题中的中文序号和“话”转换为阿拉伯数字和“章”。

默认读取指定的 TXT 文件，并在同目录生成 *_章节版.txt，不覆盖原文件。
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


DEFAULT_INPUT = Path(
    r"E:\Videos\小说\异世界触手怪和萝莉公主与她的母亲姐妹们的纯爱故事 1-15new.txt"
)

CHINESE_NUMBERS = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    "十一": 11,
    "十二": 12,
    "十三": 13,
    "十四": 14,
    "十五": 15,
}

TITLE_PATTERN = re.compile(
    r"(?m)^(?P<prefix>\s*)第(?P<number>十五|十四|十三|十二|十一|十|九|八|七|六|五|四|三|二|一)话(?=[：:\x20])"
)


def read_text(path: Path) -> tuple[str, str]:
    """读取常见中文 TXT 编码，并返回正文和实际使用的编码。"""
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding), encoding
        except UnicodeDecodeError:
            continue
    raise UnicodeError(f"无法识别文件编码：{path}")


def replace_titles(text: str) -> tuple[str, int]:
    def replacement(match: re.Match[str]) -> str:
        number = CHINESE_NUMBERS[match.group("number")]
        return f"{match.group('prefix')}第{number}章"

    return TITLE_PATTERN.subn(replacement, text)


def main() -> None:
    parser = argparse.ArgumentParser(description="把第一话至第十五话改成第1章至第15章")
    parser.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT, help="输入 TXT 文件")
    parser.add_argument("-o", "--output", type=Path, help="输出 TXT 文件；默认在原文件名后加 _章节版")
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="直接覆盖原文件（建议先备份；与 --output 不能同时使用）",
    )
    args = parser.parse_args()

    if args.in_place and args.output:
        parser.error("--in-place 不能与 --output 同时使用")
    if not args.input.is_file():
        raise SystemExit(f"找不到输入文件：{args.input}")

    text, encoding = read_text(args.input)
    converted, count = replace_titles(text)
    if count != 15:
        raise SystemExit(f"预期替换 15 处，实际找到 {count} 处；为避免误改，未写入文件。")

    output = args.input if args.in_place else args.output
    if output is None:
        output = args.input.with_name(f"{args.input.stem}_章节版{args.input.suffix}")
    output.write_text(converted, encoding=encoding)
    print(f"已替换 {count} 处：{args.input} -> {output}")


if __name__ == "__main__":
    main()

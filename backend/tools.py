write_file_tool = {
    "name": "write_file",
    "description": "Writes content to a file at the specified path. Overwrites if exists.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "The path of the file to write to."
            },
            "content": {
                "type": "STRING",
                "description": "The content to write to the file."
            }
        },
        "required": ["path", "content"]
    }
}

read_directory_tool = {
    "name": "read_directory",
    "description": "Lists the contents of a directory.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "The path of the directory to list."
            }
        },
        "required": ["path"]
    }
}

read_file_tool = {
    "name": "read_file",
    "description": "Reads the content of a file.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "The path of the file to read."
            }
        },
        "required": ["path"]
    }
}

notes_get_tool = {
    "name": "notes_get",
    "description": "Returns the current notes.md for the active project.",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

notes_set_tool = {
    "name": "notes_set",
    "description": "Overwrites notes.md for the active project with the provided content.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "content": {
                "type": "STRING",
                "description": "Full content to write into notes.md."
            }
        },
        "required": ["content"]
    }
}

notes_append_tool = {
    "name": "notes_append",
    "description": "Appends content to notes.md for the active project.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "content": {
                "type": "STRING",
                "description": "Text to append to notes.md."
            }
        },
        "required": ["content"]
    }
}

tools_list = [{"function_declarations": [
    write_file_tool,
    read_directory_tool,
    read_file_tool,
    notes_get_tool,
    notes_set_tool,
    notes_append_tool
]}]


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
    "description": "Returns the current global notes.md.",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

notes_set_tool = {
    "name": "notes_set",
    "description": "Overwrites the global notes.md with the provided content.",
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
    "description": "Appends content to the global notes.md.",
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

study_set_fields_tool = {
    "name": "study_set_fields",
    "description": "Updates the Japanese study fields UI (dynamic answer inputs).",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING", "description": "Optional title for the exercise."},
            "fields": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "key": {"type": "STRING", "description": "Field key/id."},
                        "label": {"type": "STRING", "description": "Field label."},
                        "type": {"type": "STRING", "description": "text | textarea"},
                        "placeholder": {"type": "STRING", "description": "Placeholder text."},
                        "value": {"type": "STRING", "description": "Optional prefill value."}
                    }
                }
            }
        },
        "required": ["fields"]
    }
}

tools_list[0]["function_declarations"].append(study_set_fields_tool)

study_set_page_tool = {
    "name": "study_set_page",
    "description": "Sets the current PDF page in the Japanese study viewer.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "page": {"type": "INTEGER", "description": "1-based page number."}
        },
        "required": ["page"]
    }
}

tools_list[0]["function_declarations"].append(study_set_page_tool)

study_set_notes_tool = {
    "name": "study_set_notes",
    "description": "Updates the study scratchpad notes (replace or append).",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "text": {"type": "STRING", "description": "Notes content to write."},
            "mode": {"type": "STRING", "description": "replace | append"},
            "page_index": {"type": "INTEGER", "description": "Optional scratchpad page index."}
        },
        "required": ["text"]
    }
}

tools_list[0]["function_declarations"].append(study_set_notes_tool)

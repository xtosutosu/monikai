from PIL import Image
import sys
import os

def convert_png_to_ico(png_path, ico_path):
    """Convert PNG to ICO format"""
    try:
        # Open PNG image
        img = Image.open(png_path)

        # Convert to RGBA if not already
        if img.mode != 'RGBA':
            img = img.convert('RGBA')

        # Create ICO file (multiple sizes for better quality)
        sizes = [(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)]
        icons = []

        for size in sizes:
            # Resize image
            resized = img.resize(size, Image.Resampling.LANCZOS)
            icons.append(resized)

        # Save as ICO
        icons[0].save(ico_path, format='ICO', sizes=sizes, append_images=icons[1:])
        print(f"Successfully converted {png_path} to {ico_path}")

    except Exception as e:
        print(f"Error converting image: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python convert_icon.py input.png output.ico")
        sys.exit(1)

    png_path = sys.argv[1]
    ico_path = sys.argv[2]

    if not os.path.exists(png_path):
        print(f"Input file {png_path} does not exist")
        sys.exit(1)

    convert_png_to_ico(png_path, ico_path)